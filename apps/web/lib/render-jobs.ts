import { serializeRenderJobMessage } from "@reelwalk/core";
import { addToOutbox, prisma, relayOutbox, RENDER_JOBS_TOPIC, type Prisma } from "@reelwalk/db";
import { sendRenderJobMessage } from "./queue";
import { mediaUrl } from "./storage";

/**
 * Records the queue message for a job in the transaction that writes the job
 * as QUEUED. The two commit together or not at all, so there is never a
 * QUEUED job without a message, nor a message for a job that was rolled back.
 */
export async function queueRenderJob(tx: Prisma.TransactionClient, job: { id: string; generation: number }): Promise<void> {
  await addToOutbox(tx, RENDER_JOBS_TOPIC, serializeRenderJobMessage({ jobId: job.id, generation: job.generation }));
}

/**
 * Sends what is waiting in the outbox right after a commit, so a render
 * starts without waiting for the worker's relay loop. Failing here is fine:
 * the message is safe in the database and the relay sends it later.
 */
export async function flushOutbox(): Promise<void> {
  try {
    const { failed } = await relayOutbox(prisma, { topic: RENDER_JOBS_TOPIC, send: sendRenderJobMessage });
    if (failed > 0) console.error(`Could not send ${failed} render queue message(s); the outbox relay will retry`);
  } catch (error) {
    console.error("Could not flush the outbox; the relay will retry", error);
  }
}

export type OutputUrls = { playUrl: string; downloadUrl: string };

export async function outputUrls(job: { id: string; output: { objectKey: string } | null }): Promise<OutputUrls | null> {
  if (!job.output) return null;
  const key = job.output.objectKey;
  const [playUrl, downloadUrl] = await Promise.all([mediaUrl(key), mediaUrl(key, { downloadAs: `reelwalk-${job.id}.mp4` })]);
  return { playUrl, downloadUrl };
}
