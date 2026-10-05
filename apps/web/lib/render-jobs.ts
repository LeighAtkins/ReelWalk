import { prisma } from "@reelwalk/db";
import { enqueueRenderJob } from "./queue";
import { mediaUrl } from "./storage";

/**
 * Sends the queue message for a job that was just written as QUEUED. The row
 * is committed first, so if the send fails the job is failed visibly (and can
 * be retried from the UI) instead of sitting in QUEUED with no message.
 */
export async function enqueueOrFail(job: { id: string; generation: number }): Promise<boolean> {
  try {
    await enqueueRenderJob({ jobId: job.id, generation: job.generation });
    return true;
  } catch (error) {
    console.error(`Could not enqueue render job ${job.id}`, error);
    await prisma.renderJob.updateMany({
      where: { id: job.id, status: "QUEUED", generation: job.generation },
      data: { status: "FAILED", error: "Could not reach the render queue. Try again.", finishedAt: new Date() },
    });
    return false;
  }
}

export type OutputUrls = { playUrl: string; downloadUrl: string };

export async function outputUrls(job: { id: string; output: { objectKey: string } | null }): Promise<OutputUrls | null> {
  if (!job.output) return null;
  const key = job.output.objectKey;
  const [playUrl, downloadUrl] = await Promise.all([mediaUrl(key), mediaUrl(key, { downloadAs: `reelwalk-${job.id}.mp4` })]);
  return { playUrl, downloadUrl };
}
