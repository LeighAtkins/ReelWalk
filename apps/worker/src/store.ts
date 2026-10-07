import { previewKeyFor } from "@reelwalk/core";
import type { RenderJobMessage } from "@reelwalk/core";
import type { PrismaClient } from "@reelwalk/db";
import type { ClaimedJob, JobStore, RenderResult } from "./handler";

/**
 * Prisma-backed JobStore. Each status change is one conditional UPDATE
 * (`where` includes the expected current status and generation), so the legal
 * transitions from @reelwalk/core are enforced by the database write itself
 * rather than by a read followed by a write.
 */
export function createJobStore(prisma: PrismaClient): JobStore {
  const running = (job: RenderJobMessage) => ({ id: job.jobId, generation: job.generation, status: "RUNNING" as const });

  return {
    async snapshot(jobId) {
      return prisma.renderJob.findUnique({ where: { id: jobId }, select: { status: true, generation: true, heartbeatAt: true } });
    },

    async claim(message, attempt, staleBefore) {
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
        data: { status: "RUNNING", attempt, progress: 0, startedAt: now, heartbeatAt: now, finishedAt: null },
      });
      if (claimed.count === 0) return null;

      const job = await prisma.renderJob.findUniqueOrThrow({
        where: { id: message.jobId },
        include: { mediaAsset: true, template: true },
      });
      return {
        id: job.id,
        generation: job.generation,
        kind: job.kind,
        caption: job.caption,
        payload: job.payload,
        inputKey: job.mediaAsset?.objectKey ?? null,
        brand: job.template?.brand ?? null,
        mediaAssetId: job.mediaAsset?.id ?? null,
        previewKey: job.mediaAsset ? previewKeyFor(job.mediaAsset.workspaceId, job.mediaAsset.id) : null,
      } satisfies ClaimedJob;
    },

    async heartbeat(job, progress) {
      await prisma.renderJob.updateMany({
        where: running(job),
        data: { heartbeatAt: new Date(), ...(progress === undefined ? {} : { progress }) },
      });
    },

    async succeed(job, output: RenderResult) {
      // The upsert keeps one output row per job no matter how many times the
      // job was rendered; the status write is a no-op if it already succeeded.
      await prisma.$transaction([
        prisma.renderOutput.upsert({ where: { jobId: job.jobId }, update: output, create: { jobId: job.jobId, ...output } }),
        prisma.renderJob.updateMany({
          where: running(job),
          data: { status: "SUCCEEDED", progress: 100, error: null, finishedAt: new Date() },
        }),
      ]);
    },

    async requeue(job, error) {
      await prisma.renderJob.updateMany({ where: running(job), data: { status: "QUEUED", error, heartbeatAt: null } });
    },

    async fail(job, error) {
      await prisma.renderJob.updateMany({
        where: { id: job.jobId, generation: job.generation, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED", error, finishedAt: new Date() },
      });
    },
  };
}
