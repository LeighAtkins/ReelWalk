import type { Prisma, PrismaClient } from "./generated/prisma/client";
import { addToOutbox, RENDER_JOBS_TOPIC } from "./outbox";

/**
 * Local rendering (ADR 0094). Render jobs from a few listed workspaces (our
 * own) go to a second queue that a worker on the owner's PC consumes, instead
 * of starting a Fargate task. Everything else is unchanged.
 */

/** Outbox topic of render jobs bound for the local queue; the relay sends it to LOCAL_RENDER_QUEUE_URL. */
export const LOCAL_RENDER_JOBS_TOPIC = "render-jobs-local";

export type RenderRoute = "local" | "cloud";

export type LocalRenderPolicy = {
  /** The local queue. */
  queueUrl: string;
  /** Workspaces whose renders go to it. */
  workspaceIds: ReadonlySet<string>;
  /** People (by sign-in email) whose own workspaces, home and owned, go to it. */
  emails: ReadonlySet<string>;
  /** How long a local job may wait unclaimed (or sit with a dead heartbeat) before it is moved to the cloud queue. */
  fallbackMs: number;
};

const DEFAULT_FALLBACK_SECONDS = 600;

function list(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

/**
 * The policy from LOCAL_RENDER_QUEUE_URL, LOCAL_RENDER_WORKSPACES,
 * LOCAL_RENDER_EMAILS and LOCAL_RENDER_FALLBACK_SECONDS. Null (route
 * everything to the cloud queue) unless there is a queue and someone on the list.
 */
export function localRenderPolicyFromEnv(env: Record<string, string | undefined> = process.env): LocalRenderPolicy | null {
  const queueUrl = env.LOCAL_RENDER_QUEUE_URL?.trim();
  const workspaceIds = new Set(list(env.LOCAL_RENDER_WORKSPACES));
  const emails = new Set(list(env.LOCAL_RENDER_EMAILS).map((email) => email.toLowerCase()));
  if (!queueUrl || (workspaceIds.size === 0 && emails.size === 0)) return null;
  const seconds = Number(env.LOCAL_RENDER_FALLBACK_SECONDS);
  const fallbackSeconds = env.LOCAL_RENDER_FALLBACK_SECONDS && Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_FALLBACK_SECONDS;
  return { queueUrl, workspaceIds, emails, fallbackMs: fallbackSeconds * 1000 };
}

type Db = Pick<PrismaClient | Prisma.TransactionClient, "user" | "workspaceMember">;

/**
 * Every workspace whose renders go to the local queue: the listed ones, plus
 * the home workspace and every workspace OWNED by a listed person. An EDITOR
 * membership does not count, so a customer's studio that invites us stays on
 * the cloud.
 */
export async function localRenderWorkspaceIds(db: Db, policy: LocalRenderPolicy): Promise<string[]> {
  const ids = new Set(policy.workspaceIds);
  if (policy.emails.size > 0) {
    const emails = [...policy.emails];
    const [homes, owned] = await Promise.all([
      db.user.findMany({ where: { email: { in: emails } }, select: { workspaceId: true } }),
      db.workspaceMember.findMany({ where: { role: "OWNER", user: { email: { in: emails } } }, select: { workspaceId: true } }),
    ]);
    for (const row of [...homes, ...owned]) ids.add(row.workspaceId);
  }
  return [...ids];
}

/** Where a new render job of `workspaceId` goes. */
export async function renderRouteFor(db: Db, policy: LocalRenderPolicy | null, workspaceId: string): Promise<RenderRoute> {
  if (!policy) return "cloud";
  if (policy.workspaceIds.has(workspaceId)) return "local";
  if (policy.emails.size === 0) return "cloud";
  return (await localRenderWorkspaceIds(db, policy)).includes(workspaceId) ? "local" : "cloud";
}

/** The outbox topic for a route. */
export function renderJobsTopic(route: RenderRoute): string {
  return route === "local" ? LOCAL_RENDER_JOBS_TOPIC : RENDER_JOBS_TOPIC;
}

/**
 * The fallback. A render job of a local workspace that has waited QUEUED for
 * `fallbackMs`, or is RUNNING with a heartbeat that old (the PC slept or was
 * switched off mid-render), is re-issued on the cloud queue: its generation
 * goes up, so the message still sitting on the local queue becomes stale and
 * any worker that later receives it discards it (decideDelivery), and a
 * render still finishing on a woken PC cannot publish (its lease no longer
 * matches). Each move is one conditional write, so a local worker claiming
 * the job at the same moment simply wins and nothing is moved.
 *
 * Returns how many jobs were moved; the caller flushes the outbox and starts
 * a cloud worker.
 */
export async function moveStalledLocalRenders(
  prisma: PrismaClient,
  policy: LocalRenderPolicy,
  options: { now?: Date; limit?: number; serialize: (message: { jobId: string; generation: number }) => string },
): Promise<string[]> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - policy.fallbackMs);
  const workspaceIds = await localRenderWorkspaceIds(prisma, policy);
  if (workspaceIds.length === 0) return [];
  const stalled: Prisma.RenderJobWhereInput = {
    OR: [
      { status: "QUEUED", updatedAt: { lt: cutoff } },
      { status: "RUNNING", OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] },
    ],
  };
  const candidates = await prisma.renderJob.findMany({
    where: { workspaceId: { in: workspaceIds }, ...stalled },
    select: { id: true, generation: true },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 20,
  });
  const moved: string[] = [];
  for (const job of candidates) {
    const ok = await prisma.$transaction(async (tx) => {
      const updated = await tx.renderJob.updateMany({
        where: { id: job.id, generation: job.generation, ...stalled },
        data: { status: "QUEUED", generation: { increment: 1 }, progress: 0, heartbeatAt: null, startedAt: null },
      });
      if (updated.count === 0) return false;
      await addToOutbox(tx, RENDER_JOBS_TOPIC, options.serialize({ jobId: job.id, generation: job.generation + 1 }));
      return true;
    });
    if (ok) moved.push(job.id);
  }
  return moved;
}
