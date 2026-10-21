import { buildReelExportPayload, canExport, instagramIssues, parseTimeline, referencedAssetIds, type Issue } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { workspacePlan } from "@/lib/plans";
import { exportBlockedReason } from "@/lib/quotas";
import { ensureWorkerRunning } from "@/lib/render-capacity";
import { flushOutbox, queueRenderJob } from "@/lib/render-jobs";
import { mediaScope } from "@/lib/media-scope";

export type ExportResult = { ok: false; issues: Issue[]; message?: string; /** A bigger plan would lift the limit that stopped it. */ upgrade?: boolean };

/**
 * Freezes the current timeline into a render job and queues it. The checks
 * run again here, on the server, whatever the browser showed. The job row and
 * its queue message are written in one transaction (the outbox). Used by
 * Export (which then opens the export screen) and by a variant set's
 * Export all (ADR 0063), which queues several.
 */
export async function queueReelExport(user: { id: string; workspaceId: string }, reelId: string): Promise<{ ok: true } | ExportResult> {
  const reel = await prisma.reel.findFirst({ where: { id: reelId, workspaceId: user.workspaceId } });
  if (!reel) return { ok: false, issues: [], message: "This reel was deleted." };

  const timeline = parseTimeline(reel.timeline);
  const issues = instagramIssues(timeline, reel.caption);
  if (!canExport(issues)) return { ok: false, issues };
  const blocked = await exportBlockedReason(user.workspaceId);
  if (blocked) return { ok: false, issues: [], message: blocked.message, upgrade: blocked.upgrade };

  const library = await prisma.mediaAsset.findMany({
    where: { id: { in: referencedAssetIds(timeline) }, ...mediaScope(user.workspaceId) },
    // instagramAudioId marks an Instagram sound's copy, which the render leaves out (ADR 0019).
    select: { id: true, objectKey: true, kind: true, instagramAudioId: true, transcript: true },
  });
  const { plan } = await workspacePlan(user.workspaceId);
  let payload;
  try {
    payload = buildReelExportPayload(timeline, library, { width: plan.outputWidth, watermark: plan.watermark });
  } catch (error) {
    return { ok: false, issues: [], message: error instanceof Error ? error.message : "Could not export." };
  }

  await prisma.$transaction(async (tx) => {
    const job = await tx.renderJob.create({
      data: {
        workspaceId: user.workspaceId,
        createdById: user.id,
        reelId: reel.id,
        kind: "REEL",
        payload,
        caption: reel.title,
      },
    });
    await queueRenderJob(tx, job);
  });
  await flushOutbox();
  await ensureWorkerRunning();
  return { ok: true };
}
