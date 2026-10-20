import { ECSClient, ListTasksCommand, RunTaskCommand } from "@aws-sdk/client-ecs";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { prisma } from "@reelwalk/db";

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
// Renders one worker runs at a time (the worker's RENDER_CONCURRENCY).
const jobsPerWorker = Math.max(1, Number(process.env.RENDER_JOBS_PER_WORKER ?? 1));

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

    await ecs.send(
      new RunTaskCommand({
        cluster,
        taskDefinition,
        launchType: "FARGATE",
        count: toStart,
        networkConfiguration: {
          // Public subnets with a public address: the task needs the internet for S3, SQS and ECR, and there is no NAT gateway.
          awsvpcConfiguration: { subnets, securityGroups, assignPublicIp: "ENABLED" },
        },
        startedBy: "reelwalk-web",
      }),
    );
    for (let i = 0; i < toStart; i++) launched.push(Date.now());
    console.log(`render-capacity: started ${toStart} worker task(s); ${active} already up, ${outstanding ?? "?"} job(s) outstanding`);
  }
}

/** After queueing a job: make sure workers are on their way, as many as the queue needs. */
export async function ensureWorkerRunning(): Promise<void> {
  await reconcile({ atLeastOne: true });
}

let lastReconcile = 0;

/**
 * Called by the health check (every 20 s per web instance), at most once a
 * minute per instance. Starts workers for messages nobody is working on: for
 * instance a render whose worker was killed comes back on the queue after its
 * visibility timeout, and without this would wait for the next export.
 */
export function reconcileWorkersInBackground(): void {
  if (!onDemandWorkersConfigured() || Date.now() - lastReconcile < 60_000) return;
  lastReconcile = Date.now();
  void reconcile({ atLeastOne: false });
}
