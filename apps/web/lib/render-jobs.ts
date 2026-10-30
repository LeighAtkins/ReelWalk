import { serializeRenderJobMessage } from "@reelwalk/core";
import {
  addToOutbox,
  LOCAL_RENDER_JOBS_TOPIC,
  localRenderPolicyFromEnv,
  prisma,
  relayOutbox,
  RENDER_JOBS_TOPIC,
  renderJobsTopic,
  renderRouteFor as routeFor,
  type LocalRenderPolicy,
  type Prisma,
  type RenderRoute,
} from "@reelwalk/db";
import { sendRenderJobMessage } from "./queue";
import { mediaUrl } from "./storage";

let policy: LocalRenderPolicy | null | undefined;
/** Our own workspaces render on the owner's PC (ADR 0094); null routes every job to the cloud queue. Read on first use. */
function localRender(): LocalRenderPolicy | null {
  if (policy === undefined) policy = localRenderPolicyFromEnv();
  return policy;
}

/**
 * Which queue a new render job of this workspace goes to (ADR 0094): the local
 * one only for a workspace on LOCAL_RENDER_WORKSPACES. Store the answer as the
 * job's `route`. A list check, no lookup, so it cannot fail an export.
 */
export function renderRouteFor(workspaceId: string): RenderRoute {
  return routeFor(localRender(), workspaceId);
}

/**
 * Records the queue message for a job in the transaction that writes the job
 * as QUEUED. The two commit together or not at all, so there is never a
 * QUEUED job without a message, nor a message for a job that was rolled back.
 * The topic follows the route stored on the job; the route comes back for
 * ensureWorkerRunning, which starts no cloud worker for a local job.
 */
export async function queueRenderJob(tx: Prisma.TransactionClient, job: { id: string; generation: number; route: string }): Promise<RenderRoute> {
  const route: RenderRoute = job.route === "local" ? "local" : "cloud";
  await addToOutbox(tx, renderJobsTopic(route), serializeRenderJobMessage({ jobId: job.id, generation: job.generation }));
  return route;
}

/**
 * Sends what is waiting in the outbox right after a commit, so a render
 * starts without waiting for the worker's relay loop. Failing here is fine:
 * the message is safe in the database and the relay sends it later.
 */
export async function flushOutbox(): Promise<void> {
  try {
    const [cloud, local] = await Promise.all([
      relayOutbox(prisma, { topic: RENDER_JOBS_TOPIC, send: (body) => sendRenderJobMessage(body) }),
      // Local messages left behind after the local queue was switched off go to the cloud queue.
      relayOutbox(prisma, { topic: LOCAL_RENDER_JOBS_TOPIC, send: (body) => sendRenderJobMessage(body, localRender()?.queueUrl) }),
    ]);
    const failed = cloud.failed + local.failed;
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
