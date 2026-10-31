import { ECSClient, ListTasksCommand, RunTaskCommand, type RunTaskCommandInput } from "@aws-sdk/client-ecs";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { serializeRenderJobMessage } from "@reelwalk/core";
import { localRenderFallbackMs, moveStalledLocalRenders, prisma, sweepRenderArtifacts, type RenderRoute } from "@reelwalk/db";
import { flushOutbox } from "./render-jobs";
import { deleteObjects } from "./storage";

/**
 * On-demand rendering. In the serverless deployment no worker runs between
 * exports: when a job is queued, the web app starts one Fargate task from the
 * worker image, which drains the queue and exits once it has been idle
 * (WORKER_IDLE_EXIT_SECONDS). Without ECS settings (Compose, kind, EKS) this
 * is a no-op and long-running workers pick the job up as before.
 */

const cluster = process.env.ECS_CLUSTER;
const taskDefinition = process.env.ECS_WORKER_TASK_DEFINITION;
const subnets = (process.env.ECS_SUBNETS ?? "").split(",").filter(Boolean);
const securityGroups = (process.env.ECS_SECURITY_GROUPS ?? "").split(",").filter(Boolean);
const maxWorkers = Number(process.env.ECS_MAX_WORKERS ?? 1);
const queueUrl = process.env.SQS_QUEUE_URL;
// Renders one worker runs at a time: one (it receives one message at a time). Not RENDER_CONCURRENCY, which is tabs within a render.
const jobsPerWorker = Math.max(1, Number(process.env.RENDER_JOBS_PER_WORKER ?? 1));
// Fargate Spot first (ADR 0094); ECS_SPOT=false launches on-demand Fargate only.
const useSpot = (process.env.ECS_SPOT ?? "true").toLowerCase() !== "false";
// Once a waiting cloud job has been handed back this many times (Spot reclaims), launches are on-demand.
const spotInterruptionsAllowed = Math.max(1, Number(process.env.ECS_SPOT_MAX_INTERRUPTIONS ?? 1));

export function onDemandWorkersConfigured(): boolean {
  return Boolean(cluster && taskDefinition && subnets.length > 0);
}

const region = process.env.AWS_REGION ?? "us-east-2";
const ecs = new ECSClient({ region });
const sqs = new SQSClient({ region });

/** Messages waiting, in flight or delayed for a retry: the render work outstanding. Null if the queue cannot be read. */
async function outstandingJobs(): Promise<number | null> {
  if (!queueUrl) return null;
  try {
    const [{ Attributes = {} }, aiJobs] = await Promise.all([sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
      }),
    ), prisma.aiGeneration.count({ where: { status: { in: ["QUEUED", "SUBMITTING", "RUNNING"] } } })]);
    return (
      Number(Attributes.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0) +
      Number(Attributes.ApproximateNumberOfMessagesDelayed ?? 0) + aiJobs
    );
  } catch (error) {
    console.error("render-capacity: could not read the queue", error);
    return null;
  }
}

/**
 * How many workers to start: what the queue needs, capped at `maxWorkers`,
 * less those already up and those started in the last minute that ECS may
 * not list yet. With `atLeastOne`, a just-queued job always gets a worker
 * even if the queue count lags. Pure, so the arithmetic is tested.
 */
export function planLaunches({ active, recent, outstanding, atLeastOne, maxWorkers: cap = maxWorkers, perWorker = jobsPerWorker }: { active: number; recent: number; outstanding: number | null; atLeastOne: boolean; maxWorkers?: number; perWorker?: number }): number {
  const needed = outstanding === null ? (atLeastOne ? 1 : 0) : Math.ceil(outstanding / perWorker);
  const wanted = Math.min(cap, Math.max(atLeastOne ? 1 : 0, needed));
  return Math.max(0, Math.min(10, wanted - active - recent));
}

/** Launches this instance asked for recently: ECS lists a task only once it is placed, so a second reconcile a moment later must not start it again. */
const launched: number[] = [];
const RECENT_MS = 90_000;
function recentLaunches(now: number): number {
  while (launched.length && now - launched[0] > RECENT_MS) launched.shift();
  return launched.length;
}

/** The advisory lock every reconcile takes, so two web instances (or two exports on one) never both start the same worker. */
const LOCK_KEY = 827_364;
let inFlight: Promise<void> | null = null;

/**
 * Brings the number of worker tasks up to what the queue needs, capped at
 * ECS_MAX_WORKERS. One reconcile runs at a time on this instance, and across
 * instances a Postgres advisory lock serialises them; a reconcile that finds
 * the lock taken simply returns, since the holder is doing the same work.
 * Never throws: a failure only delays renders.
 */
async function reconcile({ atLeastOne }: { atLeastOne: boolean }): Promise<void> {
  if (!onDemandWorkersConfigured()) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await prisma.$transaction(async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`;
        if (!locked) return;
        await reconcileLocked({ atLeastOne });
      }, { timeout: 20_000 });
    } catch (error) {
      console.error("render-capacity: could not start a worker task", error);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function reconcileLocked({ atLeastOne }: { atLeastOne: boolean }): Promise<void> {
  {
    const family = taskDefinition!.split("/").pop()!.split(":")[0]!;
    const [running, pending, outstanding] = await Promise.all([
      ecs.send(new ListTasksCommand({ cluster, family, desiredStatus: "RUNNING" })),
      ecs.send(new ListTasksCommand({ cluster, family, desiredStatus: "PENDING" })),
      outstandingJobs(),
    ]);
    const active = (running.taskArns?.length ?? 0) + (pending.taskArns?.length ?? 0);
    const toStart = planLaunches({ active, recent: recentLaunches(Date.now()), outstanding, atLeastOne });
    if (toStart <= 0) return;

    const { started, spot } = await startWorkerTasks(ecs, {
      cluster,
      taskDefinition,
      count: toStart,
      networkConfiguration: {
        // Public subnets with a public address: the task needs the internet for S3, SQS and ECR, and there is no NAT gateway.
        awsvpcConfiguration: { subnets, securityGroups, assignPublicIp: "ENABLED" },
      },
      startedBy: "reelwalk-web",
    }, { spot: useSpot && !(await interruptedJobWaiting()) });
    for (let i = 0; i < started; i++) launched.push(Date.now());
    console.log(`render-capacity: started ${started} of ${toStart} worker task(s) (${spot} on Spot); ${active} already up, ${outstanding ?? "?"} job(s) outstanding`);
  }
}

/**
 * Whether a cloud job waiting for a worker has already been interrupted
 * (handed back on SIGTERM, usually a Spot reclaim) as often as Spot is
 * allowed: then the next worker is on-demand, so a job is not restarted by
 * reclaim after reclaim. If the count cannot be read, Spot is not used.
 */
export async function interruptedJobWaiting(): Promise<boolean> {
  try {
    return (await prisma.renderJob.count({ where: { route: "cloud", status: { in: ["QUEUED", "RUNNING"] }, interruptions: { gte: spotInterruptionsAllowed } } })) > 0;
  } catch (error) {
    console.error("render-capacity: could not count interrupted jobs; launching on-demand", error);
    return true;
  }
}

type RunTaskBase = Omit<RunTaskCommandInput, "launchType" | "capacityProviderStrategy">;

/**
 * Starts `count` worker tasks, on Fargate Spot first and on-demand Fargate for
 * whatever Spot could not place (no Spot capacity, or the cluster has no Spot
 * provider). A Spot task that is reclaimed mid-render gets SIGTERM and hands
 * its job back to the queue (ADR 0050), so the next reconcile starts another.
 */
export async function startWorkerTasks(client: Pick<ECSClient, "send">, base: RunTaskBase, { spot }: { spot: boolean }): Promise<{ started: number; spot: number }> {
  const count = base.count ?? 1;
  let onSpot = 0;
  if (spot) {
    try {
      const result = await client.send(new RunTaskCommand({ ...base, count, capacityProviderStrategy: [{ capacityProvider: "FARGATE_SPOT", weight: 1 }] }));
      onSpot = result.tasks?.length ?? 0;
      if (onSpot < count) console.warn(`render-capacity: Spot placed ${onSpot} of ${count}: ${(result.failures ?? []).map((f) => f.reason).join("; ") || "no reason given"}`);
    } catch (error) {
      console.warn("render-capacity: Spot launch refused, using on-demand Fargate", error);
    }
  }
  const rest = count - onSpot;
  if (rest <= 0) return { started: onSpot, spot: onSpot };
  const result = await client.send(new RunTaskCommand({ ...base, count: rest, capacityProviderStrategy: [{ capacityProvider: "FARGATE", weight: 1 }] }));
  return { started: onSpot + (result.tasks?.length ?? 0), spot: onSpot };
}

/**
 * After queueing a job: make sure workers are on their way, as many as the
 * queue needs. A job routed to the local queue (ADR 0094) starts nothing:
 * the PC's worker takes it, or the fallback moves it here after a while.
 */
export async function ensureWorkerRunning(route: RenderRoute = "cloud"): Promise<void> {
  if (route === "local") return;
  await reconcile({ atLeastOne: true });
}

/**
 * Moves jobs sent to the local queue that nobody has picked up (the PC is
 * off) to the cloud queue and starts a worker for them. It follows each job's
 * stored route, so it runs whatever the current policy says. Never throws.
 */
export async function rescueStalledLocalRenders(now = new Date()): Promise<number> {
  const fallbackMs = localRenderFallbackMs();
  try {
    const moved = await moveStalledLocalRenders(prisma, { fallbackMs, now, serialize: serializeRenderJobMessage });
    if (moved.length === 0) return 0;
    console.log(`render-capacity: ${moved.length} local render(s) waited over ${fallbackMs / 1000}s, moved to the cloud queue: ${moved.join(", ")}`);
    await flushOutbox();
    await reconcile({ atLeastOne: true });
    return moved.length;
  } catch (error) {
    console.error("render-capacity: could not move stalled local renders", error);
    return 0;
  }
}

/** Run objects (a losing preview run's files, ADR 0094) older than this and referenced by nothing are deleted. */
const artifactGraceMs = Number(process.env.RENDER_ARTIFACT_GRACE_HOURS ?? 24) * 3_600_000;

/** Deletes losing and dead runs' files. Never throws. */
export async function sweepOrphanedRenderFiles(now = new Date()): Promise<number> {
  try {
    const deleted = await sweepRenderArtifacts(prisma, { graceMs: artifactGraceMs, now, deleteObjects });
    if (deleted.length > 0) console.log(`render-capacity: deleted ${deleted.length} file(s) no run published`);
    return deleted.length;
  } catch (error) {
    console.error("render-capacity: could not sweep orphaned render files", error);
    return 0;
  }
}

let lastReconcile = 0;

/**
 * Called by the health check (every 20 s per web instance), at most once a
 * minute per instance. Starts workers for messages nobody is working on: for
 * instance a render whose worker was killed comes back on the queue after its
 * visibility timeout, and without this would wait for the next export. It
 * first moves local renders the PC has not taken to the cloud queue, and
 * sends what is waiting in the outbox.
 */
export function reconcileWorkersInBackground(): void {
  if (Date.now() - lastReconcile < 60_000) return;
  lastReconcile = Date.now();
  // The flush sends what the PC worker handed off (it writes the cloud message to the outbox, ADR 0094).
  void rescueStalledLocalRenders().then(() => flushOutbox()).then(() => reconcile({ atLeastOne: false })).then(() => sweepOrphanedRenderFiles());
}
