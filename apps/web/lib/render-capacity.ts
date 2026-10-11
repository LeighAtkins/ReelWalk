import { ECSClient, ListTasksCommand, RunTaskCommand } from "@aws-sdk/client-ecs";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

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
    const { Attributes = {} } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
      }),
    );
    return (
      Number(Attributes.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0) +
      Number(Attributes.ApproximateNumberOfMessagesDelayed ?? 0)
    );
  } catch (error) {
    console.error("render-capacity: could not read the queue", error);
    return null;
  }
}

/**
 * Brings the number of worker tasks up to what the queue needs, capped at
 * ECS_MAX_WORKERS. With `atLeastOne`, a just-queued job always gets a worker
 * even if the queue count lags. Never throws: a failure only delays renders.
 */
async function reconcile({ atLeastOne }: { atLeastOne: boolean }): Promise<void> {
  if (!onDemandWorkersConfigured()) return;
  try {
    const family = taskDefinition!.split("/").pop()!.split(":")[0]!;
    const [running, pending, outstanding] = await Promise.all([
      ecs.send(new ListTasksCommand({ cluster, family, desiredStatus: "RUNNING" })),
      ecs.send(new ListTasksCommand({ cluster, family, desiredStatus: "PENDING" })),
      outstandingJobs(),
    ]);
    const active = (running.taskArns?.length ?? 0) + (pending.taskArns?.length ?? 0);
    const needed = outstanding === null ? (atLeastOne ? 1 : 0) : Math.ceil(outstanding / jobsPerWorker);
    const wanted = Math.min(maxWorkers, Math.max(atLeastOne ? 1 : 0, needed));
    const toStart = Math.min(10, wanted - active);
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
    console.log(`render-capacity: started ${toStart} worker task(s); ${active} already up, ${outstanding ?? "?"} job(s) outstanding`);
  } catch (error) {
    console.error("render-capacity: could not start a worker task", error);
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
