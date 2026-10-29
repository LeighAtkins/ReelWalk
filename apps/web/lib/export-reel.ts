import { buildReelExportPayload, canExport, instagramIssues, parseTimeline, referencedAssetIds, type Issue } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { recordFunnelEvent } from "@/lib/funnel";
import { workspacePlan } from "@/lib/plans";
import { exportBlockedReason } from "@/lib/quotas";
import { ensureWorkerRunning } from "@/lib/render-capacity";
import { flushOutbox, queueRenderJob } from "@/lib/render-jobs";
import { mediaScope } from "@/lib/media-scope";

export type ExportResult = { ok: false; issues: Issue[]; message?: string; /** A bigger plan would lift the limit that stopped it. */ upgrade?: boolean; /** The reel is no longer at the revision asked for. */ conflict?: boolean };

/**
 * Freezes the current timeline into a render job and queues it. The checks
 * run again here, on the server, whatever the browser showed. The job row and
 * its queue message are written in one transaction (the outbox). Used by
 * Export (which then opens the export screen) and by a variant set's
 * Export all (ADR 0063), which queues several. With `revision`, only that
 * revision is exported: a reel saved since answers `conflict` and nothing is
 * queued (a note exports exactly the cut it made, ADR 0095). Answers with the
 * id of the job it created.
 */
export async function queueReelExport(user: { id: string; workspaceId: string }, reelId: string, options: { revision?: number } = {}): Promise<{ ok: true; jobId: string } | ExportResult> {
  const reel = await prisma.reel.findFirst({ where: { id: reelId, workspaceId: user.workspaceId } });
  if (!reel) return { ok: false, issues: [], message: "This reel was deleted." };
  if (options.revision !== undefined && reel.revision !== options.revision) return { ok: false, issues: [], conflict: true, message: "The reel was changed after that edit, so it was not exported." };

  const timeline = parseTimeline(reel.timeline);
  const issues = instagramIssues(timeline, reel.caption);
  if (!canExport(issues)) return { ok: false, issues };
  const blocked = await exportBlockedReason(user.workspaceId);
  if (blocked) return { ok: false, issues: [], message: blocked.message, upgrade: blocked.upgrade };

  const library = await prisma.mediaAsset.findMany({
    where: { id: { in: referencedAssetIds(timeline) }, ...mediaScope(user.workspaceId) },
    // instagramAudioId marks an Instagram sound's copy, which the render leaves out (ADR 0019).
    select: { id: true, objectKey: true, kind: true, instagramAudioId: true, transcript: true, durationMs: true },
  });
  const { plan } = await workspacePlan(user.workspaceId);
  let payload;
  try {
    payload = buildReelExportPayload(timeline, library, { width: plan.outputWidth, watermark: plan.watermark });
  } catch (error) {
    return { ok: false, issues: [], message: error instanceof Error ? error.message : "Could not export." };
  }

  const jobId = await prisma.$transaction(async (tx) => {
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
    return job.id;
  });
  // Once per studio, the key makes later exports a no-op (ADR 0080).
  await recordFunnelEvent({ name: "first_export", userId: user.id, workspaceId: user.workspaceId, key: `first_export:${user.workspaceId}`, data: { plan: plan.id } });
  await flushOutbox();
  await ensureWorkerRunning();
  return { ok: true, jobId };
}
