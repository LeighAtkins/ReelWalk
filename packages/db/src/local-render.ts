import type { Prisma, PrismaClient } from "./generated/prisma/client";
import { addToOutbox, RENDER_JOBS_TOPIC } from "./outbox";

/**
 * Local rendering (ADR 0094). Render jobs from a few listed workspaces (our
 * own) go to a second queue that a worker on the owner's PC consumes, instead
 * of starting a Fargate task. Everything else is unchanged.
 *
 * Which workspaces is an explicit list (LOCAL_RENDER_WORKSPACES), the same
 * one the PC worker's IAM user may write for. The route is decided once, when
 * a generation is queued, and stored on the job (`RenderJob.route`). Everything after that (the relay, the fallback,
 * the PC worker's hand-off) follows the stored route, never who owns the
 * workspace now.
 */

/** Outbox topic of render jobs bound for the local queue; the relay sends it to LOCAL_RENDER_QUEUE_URL. */
export const LOCAL_RENDER_JOBS_TOPIC = "render-jobs-local";

export type RenderRoute = "local" | "cloud";

export type LocalRenderPolicy = {
  /** The local queue. */
  queueUrl: string;
  /**
   * Workspaces whose renders go to it: an explicit list, the same one the PC
   * worker's IAM user may write for (`local/<workspaceId>/`), so routing and
   * permissions can never disagree.
   */
  workspaceIds: ReadonlySet<string>;
};

const DEFAULT_FALLBACK_SECONDS = 600;

function list(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

/** The workspaces in LOCAL_RENDER_WORKSPACES (comma or space separated). */
export function localRenderWorkspacesFromEnv(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  return new Set(list(env.LOCAL_RENDER_WORKSPACES));
}

/**
 * The policy from LOCAL_RENDER_QUEUE_URL and LOCAL_RENDER_WORKSPACES. Null
 * (route everything to the cloud queue) unless there is a queue and a
 * workspace on the list.
 */
export function localRenderPolicyFromEnv(env: Record<string, string | undefined> = process.env): LocalRenderPolicy | null {
  const queueUrl = env.LOCAL_RENDER_QUEUE_URL?.trim();
  const workspaceIds = localRenderWorkspacesFromEnv(env);
  if (!queueUrl || workspaceIds.size === 0) return null;
  return { queueUrl, workspaceIds };
}

/** How long a local job may wait unclaimed, or sit with a dead heartbeat, before it moves to the cloud queue. */
export function localRenderFallbackMs(env: Record<string, string | undefined> = process.env): number {
  const seconds = Number(env.LOCAL_RENDER_FALLBACK_SECONDS);
  return (env.LOCAL_RENDER_FALLBACK_SECONDS && Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_FALLBACK_SECONDS) * 1000;
}

/**
 * Where a new render job of a workspace goes: local only if the workspace is
 * on the list. No database lookup, so routing can neither fail nor slow an
 * export, and nothing is cached that could go stale.
 */
export function renderRouteFor(policy: LocalRenderPolicy | null, workspaceId: string): RenderRoute {
  return policy?.workspaceIds.has(workspaceId) ? "local" : "cloud";
}

/** The outbox topic for a route. */
export function renderJobsTopic(route: RenderRoute): string {
  return route === "local" ? LOCAL_RENDER_JOBS_TOPIC : RENDER_JOBS_TOPIC;
}

type Serialize = (message: { jobId: string; generation: number }) => string;

/**
 * Moves one local job to the cloud queue, inside `tx`: one conditional write
 * flips the route to "cloud" and bumps the generation (so the message still on
 * the local queue becomes stale and is discarded, and a render still running
 * on a PC that woke up cannot publish), then a cloud message for the new
 * generation goes into the outbox. `where` narrows when the move applies; if
 * the row no longer matches (claimed, finished, already moved) nothing is
 * written and it returns false.
 */
async function moveToCloud(tx: Prisma.TransactionClient, job: { id: string; generation: number }, where: Prisma.RenderJobWhereInput, serialize: Serialize): Promise<boolean> {
  const updated = await tx.renderJob.updateMany({
    where: { id: job.id, generation: job.generation, route: "local", ...where },
    // A fresh start on the cloud: its interruptions budget (Spot) is its own.
    data: { route: "cloud", status: "QUEUED", generation: { increment: 1 }, progress: 0, heartbeatAt: null, startedAt: null, interruptions: 0 },
  });
  if (updated.count === 0) return false;
  await addToOutbox(tx, RENDER_JOBS_TOPIC, serialize({ jobId: job.id, generation: job.generation + 1 }));
  return true;
}

/**
 * The fallback. A job sent to the local queue that has waited QUEUED for
 * `fallbackMs`, or is RUNNING with a heartbeat that old (the PC slept or was
 * switched off mid-render), is moved to the cloud queue. It selects by the
 * stored route, so it rescues whatever was sent to the PC whoever owns the
 * workspace now, and a job it moved is a cloud job and is never moved again.
 * Returns the ids moved; the caller flushes the outbox and starts a worker.
 */
export async function moveStalledLocalRenders(
  prisma: PrismaClient,
  options: { fallbackMs: number; now?: Date; limit?: number; serialize: Serialize },
): Promise<string[]> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.fallbackMs);
  const stalled: Prisma.RenderJobWhereInput = {
    OR: [
      { status: "QUEUED", updatedAt: { lt: cutoff } },
      { status: "RUNNING", OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] },
    ],
  };
  const candidates = await prisma.renderJob.findMany({
    where: { route: "local", ...stalled },
    select: { id: true, generation: true },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 20,
  });
  const moved: string[] = [];
  for (const job of candidates) {
    if (await prisma.$transaction((tx) => moveToCloud(tx, job, stalled, options.serialize))) moved.push(job.id);
  }
  return moved;
}

/**
 * The PC worker gives a job it has not claimed to the cloud queue: it could
 * not get the shared-PC lock in time. The job was never claimed, so no attempt
 * is spent, and the cloud message starts its receive count afresh. False when
 * the job is no longer this queued local generation (already moved, claimed or
 * finished), in which case the local message is stale anyway.
 */
export async function handOffLocalRender(prisma: PrismaClient, message: { jobId: string; generation: number }, serialize: Serialize): Promise<boolean> {
  return prisma.$transaction((tx) => moveToCloud(tx, { id: message.jobId, generation: message.generation }, { status: "QUEUED" }, serialize));
}
