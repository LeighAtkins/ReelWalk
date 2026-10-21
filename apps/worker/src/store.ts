import { previewKeyFor } from "@reelwalk/core";
import type { PrismaClient } from "@reelwalk/db";
import type { ClaimedJob, JobStore, Lease, RenderResult } from "./handler";

/**
 * Prisma-backed JobStore. Each status change is one conditional UPDATE
 * (`where` includes the expected current status and generation), so the legal
 * transitions from @reelwalk/core are enforced by the database write itself
 * rather than by a read followed by a write.
 */
export function createJobStore(prisma: PrismaClient): JobStore {
  // The row is this run's only while it is RUNNING under the attempt this run claimed: a worker that was
  // declared stale and comes back finds the attempt moved on and none of its writes land.
  const running = (lease: Lease) => ({ id: lease.jobId, generation: lease.generation, attempt: lease.attempt, status: "RUNNING" as const });

  return {
    async snapshot(jobId) {
      return prisma.renderJob.findUnique({ where: { id: jobId }, select: { status: true, generation: true, heartbeatAt: true } });
    },

    async claim(message, staleBefore) {
      const now = new Date();
      const claimed = await prisma.renderJob.updateMany({
        where: {
          id: message.jobId,
          generation: message.generation,
          OR: [
            { status: "QUEUED" },
            { status: "RUNNING", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }] },
          ],
        },
        // The attempt counts claims, not SQS receives: a message handed back on shutdown is a new message
        // whose receive count starts again, and the attempt names the output, so it must never repeat.
        data: { status: "RUNNING", attempt: { increment: 1 }, progress: 0, startedAt: now, heartbeatAt: now, finishedAt: null },
      });
      if (claimed.count === 0) return null;

      const job = await prisma.renderJob.findUniqueOrThrow({
        where: { id: message.jobId },
        include: { mediaAsset: true, template: true },
      });
      return {
        id: job.id,
        generation: job.generation,
        attempt: job.attempt,
        kind: job.kind,
        caption: job.caption,
        payload: job.payload,
        inputKey: job.mediaAsset?.objectKey ?? null,
        brand: job.template?.brand ?? null,
        mediaAssetId: job.mediaAsset?.id ?? null,
        previewKey: job.mediaAsset ? previewKeyFor(job.mediaAsset.workspaceId, job.mediaAsset.id) : null,
      } satisfies ClaimedJob;
    },

    async heartbeat(lease, progress) {
      await prisma.renderJob.updateMany({
        where: running(lease),
        data: { heartbeatAt: new Date(), ...(progress === undefined ? {} : { progress }) },
      });
    },

    async succeed(lease, output: RenderResult) {
      // The status flip is the guard: only the run that still holds the job may publish, and the output
      // row (one per job, however many times it was rendered) is written in the same transaction, so a
      // stale worker's file never replaces the one the job's current run made.
      return prisma.$transaction(async (tx) => {
        const done = await tx.renderJob.updateMany({
          where: running(lease),
          data: { status: "SUCCEEDED", progress: 100, error: null, finishedAt: new Date() },
        });
        if (done.count === 0) return false;
        await tx.renderOutput.upsert({ where: { jobId: lease.jobId }, update: output, create: { jobId: lease.jobId, ...output } });
        return true;
      });
    },

    async requeue(lease, error) {
      await prisma.renderJob.updateMany({ where: running(lease), data: { status: "QUEUED", error, heartbeatAt: null } });
    },

    async failAbandoned(message, error) {
      await prisma.renderJob.updateMany({
        where: { id: message.jobId, generation: message.generation, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED", error, finishedAt: new Date() },
      });
    },

    async fail(lease, error) {
      await prisma.renderJob.updateMany({
        where: { id: lease.jobId, generation: lease.generation, attempt: lease.attempt, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED", error, finishedAt: new Date() },
      });
    },
  };
}
