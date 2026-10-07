import { ECSClient, ListTasksCommand, RunTaskCommand } from "@aws-sdk/client-ecs";

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

export function onDemandWorkersConfigured(): boolean {
  return Boolean(cluster && taskDefinition && subnets.length > 0);
}

const ecs = new ECSClient({ region: process.env.AWS_REGION ?? "us-east-2" });

/** Starts a worker task unless enough are already running or starting. Never throws: a failure here only delays the render. */
export async function ensureWorkerRunning(): Promise<void> {
  if (!onDemandWorkersConfigured()) return;
  try {
    const family = taskDefinition!.split("/").pop()!.split(":")[0]!;
    const [running, pending] = await Promise.all([
      ecs.send(new ListTasksCommand({ cluster, family, desiredStatus: "RUNNING" })),
      ecs.send(new ListTasksCommand({ cluster, family, desiredStatus: "PENDING" })),
    ]);
    const active = (running.taskArns?.length ?? 0) + (pending.taskArns?.length ?? 0);
    if (active >= maxWorkers) return;

    await ecs.send(
      new RunTaskCommand({
        cluster,
        taskDefinition,
        launchType: "FARGATE",
        count: 1,
        networkConfiguration: {
          // Public subnets with a public address: the task needs the internet for S3, SQS and ECR, and there is no NAT gateway.
          awsvpcConfiguration: { subnets, securityGroups, assignPublicIp: "ENABLED" },
        },
        startedBy: "reelwalk-web",
      }),
    );
    console.log("render-capacity: started a worker task");
  } catch (error) {
    console.error("render-capacity: could not start a worker task", error);
  }
}
