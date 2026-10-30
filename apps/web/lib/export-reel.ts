import { buildReelExportPayload, canExport, instagramIssues, parseTimeline, referencedAssetIds, type Issue } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { recordFunnelEvent } from "@/lib/funnel";
import { workspacePlan } from "@/lib/plans";
import { exportBlockedReason } from "@/lib/quotas";
import { ensureWorkerRunning } from "@/lib/render-capacity";
import { flushOutbox, queueRenderJob, renderRouteFor } from "@/lib/render-jobs";
import { mediaScope } from "@/lib/media-scope";
import type { Tx } from "@/lib/save-fence";
import type { RenderRoute } from "@reelwalk/db";

export type ExportResult = { ok: false; issues: Issue[]; message?: string; /** A bigger plan would lift the limit that stopped it. */ upgrade?: boolean; /** The reel is no longer at the revision asked for. */ conflict?: boolean; /** The caller's fence refused it (a stopped note). */ fenced?: boolean };

/**
 * A condition on an export, checked and recorded inside the transaction that
 * creates the job and its queue message (a note's export, ADR 0095), in the
 * same shape and lock order as a save's fence (lib/save-fence.ts): `lock`
 * (the note), then the reel's row, then `inTime` right before creating the
 * job and again after (rolling it back), then `committed` records the job.
 */
export type ExportFence = { lock(tx: Tx): Promise<string | null>; inTime(tx: Tx): Promise<string | null>; committed(tx: Tx, jobId: string): Promise<void> };

type ExportOptions = { revision?: number; fence?: ExportFence };

class ExportRefused extends Error {
  constructor(message: string, readonly result: ExportResult) {
    super(message);
  }
}

/**
 * The job row, its outbox message, and the caller's fence, in one
 * transaction. The reel's row is locked (after the fence's note) and held
 * until the job is written, so with `revision` the reel is still at it when
 * the job is created: an owner's save waits for this export rather than
 * slipping in between. Answers the job's id.
 */
export async function commitReelExport(input: { user: { id: string; workspaceId: string }; reelId: string; payload: unknown; caption: string; route?: RenderRoute } & ExportOptions): Promise<{ ok: true; jobId: string } | ExportResult> {
  try {
    const jobId = await prisma.$transaction(
      async (tx) => {
        const fenced = (message: string) => new ExportRefused(message, { ok: false, issues: [], fenced: true, message });
        const stopped = input.fence ? await input.fence.lock(tx) : null;
        if (stopped) throw fenced(stopped);
        const [reel] = await tx.$queryRaw<{ revision: number }[]>`SELECT revision FROM "Reel" WHERE id = ${input.reelId} AND "workspaceId" = ${input.user.workspaceId} FOR UPDATE`;
        if (!reel) throw new ExportRefused("missing", { ok: false, issues: [], message: "This reel was deleted." });
        if (input.revision !== undefined && reel.revision !== input.revision) {
          throw new ExportRefused("conflict", { ok: false, issues: [], conflict: true, message: "The reel was changed after that edit, so it was not exported." });
        }
        const late = input.fence ? await input.fence.inTime(tx) : null;
        if (late) throw fenced(late);
        const job = await tx.renderJob.create({
          data: { route: input.route ?? renderRouteFor(input.user.workspaceId), workspaceId: input.user.workspaceId, createdById: input.user.id, reelId: input.reelId, kind: "REEL", payload: input.payload as never, caption: input.caption },
        });
        await queueRenderJob(tx, job);
        const after = input.fence ? await input.fence.inTime(tx) : null;
        if (after) throw fenced(after);
        await input.fence?.committed(tx, job.id);
        return job.id;
      },
      { timeout: 15_000 },
    );
    return { ok: true, jobId };
  } catch (error) {
    if (error instanceof ExportRefused) return error.result;
    throw error;
  }
}

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
export async function queueReelExport(user: { id: string; workspaceId: string }, reelId: string, options: ExportOptions = {}): Promise<{ ok: true; jobId: string } | ExportResult> {
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

  // Routed outside the transaction (ADR 0094): our own workspaces render on the PC.
  const route = renderRouteFor(user.workspaceId);
  const committed = await commitReelExport({ user, reelId: reel.id, payload, caption: reel.title, route, ...options });
  if (!committed.ok) return committed;
  const { jobId } = committed;
  // Once per studio, the key makes later exports a no-op (ADR 0080).
  await recordFunnelEvent({ name: "first_export", userId: user.id, workspaceId: user.workspaceId, key: `first_export:${user.workspaceId}`, data: { plan: plan.id } });
  await flushOutbox();
  await ensureWorkerRunning(route);
  return { ok: true, jobId };
}
