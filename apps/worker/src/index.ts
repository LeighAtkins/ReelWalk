import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { prisma, relayOutbox, RENDER_JOBS_TOPIC } from "@reelwalk/db";
import { getConfig } from "./config";
import { handleDeadLetter, handleDelivery, type Delivery } from "./handler";
import { renderJob } from "./render";
import { createJobStore } from "./store";
import { processAiVideo } from "./ai-video";
import { processPresenterKit } from "./presenter-kits";
import { AI_STEP_QUEUE_RETENTION_MS, AI_STEP_REAP_AFTER_MS } from "@reelwalk/core";
import { createAiStepStore, type AiStepDeps } from "./ai-jobs";
import { aiStepExecutor } from "./ai-executor";

const config = getConfig();

const sqs = new SQSClient({
  region: config.awsRegion,
  endpoint: config.sqsEndpointUrl,
  // The local emulator accepts any credentials; on AWS the default chain applies.
  credentials: config.sqsEndpointUrl ? { accessKeyId: "local", secretAccessKey: "local" } : undefined,
});

const s3 = new S3Client({
  endpoint: config.s3EndpointUrl,
  region: config.s3Region,
  forcePathStyle: config.s3ForcePathStyle,
  credentials:
    config.s3AccessKeyId && config.s3SecretAccessKey
      ? { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey }
      : undefined,
});

const store = createJobStore(prisma);
// Durable AI steps (ADR 0049) arrive on the render queue and use the same lease settings.
const aiSteps: AiStepDeps = { store: createAiStepStore(prisma), executor: aiStepExecutor, config: { ...config, aiStepTimeoutSeconds: Number(process.env.AI_STEP_TIMEOUT_SECONDS ?? 600) } };

let stopping = false;
let lastTickAt = Date.now();
let lastWorkAt = Date.now();
let aiBusy = false;
const shutdown = new AbortController();

function toDelivery(queueUrl: string, message: Message): Delivery {
  const receipt = { QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle };
  return {
    body: message.Body ?? "",
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? "1"),
    async extend(seconds) {
      lastTickAt = Date.now();
      await sqs.send(new ChangeMessageVisibilityCommand({ ...receipt, VisibilityTimeout: seconds }));
    },
    async delete() {
      await sqs.send(new DeleteMessageCommand(receipt));
    },
    // A fresh copy first, then the delete: if the delete fails there is a duplicate (which decideDelivery
    // sorts out), never a lost job. The copy's receive count starts at 1 (ADR 0050).
    async handBack() {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: message.Body ?? "" }), { abortSignal: AbortSignal.timeout(10_000) });
      await sqs.send(new DeleteMessageCommand(receipt));
    },
  };
}

async function receive(queueUrl: string): Promise<Message | undefined> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      // One render at a time per pod; scale by adding pods, not by batching.
      MaxNumberOfMessages: 1,
      // Long polling: the call waits for a message instead of spinning.
      WaitTimeSeconds: 10,
      VisibilityTimeout: config.visibilitySeconds,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
    { abortSignal: shutdown.signal },
  );
  return result.Messages?.[0];
}

async function pollLoop(name: string, queueUrl: string, handle: (delivery: Delivery) => Promise<unknown>, idleExit = false) {
  console.log(`${name}: polling ${queueUrl}`);
  while (!stopping) {
    lastTickAt = Date.now();
    try {
      const message = await receive(queueUrl);
      if (message) {
        lastWorkAt = Date.now();
        await handle(toDelivery(queueUrl, message));
        lastWorkAt = Date.now();
      } else if (idleExit && !aiBusy && config.idleExitSeconds > 0 && Date.now() - lastWorkAt > config.idleExitSeconds * 1000) {
        if (await prisma.aiGeneration.count({ where: { status: { in: ["QUEUED", "SUBMITTING", "RUNNING"] } } })) continue;
        console.log(`${name}: idle for ${config.idleExitSeconds}s, exiting`);
        stopping = true;
        shutdown.abort();
      }
    } catch (error) {
      if (stopping) break;
      console.error(`${name}: loop error, backing off`, error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  console.log(`${name}: stopped`);
}

/**
 * Outbox relay. The web app writes each queue message to the database in the
 * same transaction as its job row and normally sends it straight away. This
 * loop sends whatever is left: messages whose first send failed, or whose web
 * process died between the commit and the send.
 */
// AI steps whose queue message may be gone (ADR 0049) are re-enqueued or settled here, at most once a minute,
// by every worker. Not in a worker's first five minutes: messages waiting for it are delivered first.
let lastReapAt = Date.now() + 4 * 60_000;
async function reapAiSteps() {
  if (Date.now() - lastReapAt < 60_000) return;
  lastReapAt = Date.now();
  try {
    const { requeued, failed, unresolved } = await aiSteps.store.reapAbandoned(new Date(), {
      maxAgeMs: Number(process.env.AI_STEP_REAP_SECONDS ?? AI_STEP_REAP_AFTER_MS / 1000) * 1000,
      retentionMs: Number(process.env.AI_STEP_QUEUE_RETENTION_SECONDS ?? AI_STEP_QUEUE_RETENTION_MS / 1000) * 1000,
    });
    if (requeued || failed || unresolved) console.log(`ai-steps: re-enqueued ${requeued}, reaped ${failed} failed, ${unresolved} unresolved`);
  } catch (error) {
    console.error("ai-steps: reaper error", error);
  }
}

async function outboxLoop() {
  console.log(`outbox: relaying to ${config.queueUrl}`);
  while (!stopping) {
    try {
      const { sent, failed } = await relayOutbox(prisma, {
        topic: RENDER_JOBS_TOPIC,
        send: async (body) => {
          await sqs.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: body }), {
            abortSignal: AbortSignal.timeout(10_000),
          });
        },
      });
      if (sent > 0 || failed > 0) console.log(`outbox: sent ${sent}, failed ${failed}`);
    } catch (error) {
      if (stopping) break;
      console.error("outbox: relay error", error);
    }
    await reapAiSteps();
    await sleep(config.outboxPollSeconds * 1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
  console.log("outbox: stopped");
}

// Liveness for Kubernetes: healthy while the loop (or a render heartbeat) keeps ticking.
const health = http.createServer((_request, response) => {
  const alive = Date.now() - lastTickAt < (config.visibilitySeconds + 30) * 1000;
  response.writeHead(alive ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok: alive }));
});
health.listen(config.healthPort);

// On SIGTERM (rollout, scale-down, ECS task stop) stop taking new work; the
// current render may run for RENDER_SHUTDOWN_DRAIN_SECONDS (0 on ECS, which
// kills the task 30 s after the signal), then is stopped (ADR 0050): it
// unwinds and releases Chrome, ffmpeg and its temp files within twice
// RENDER_ABORT_GRACE_SECONDS, and the job is handed back as a fresh message so
// the interruption does not spend one of its attempts. If the task is killed
// first, the message reappears after its visibility timeout and another
// worker reclaims the job.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, stopping${config.shutdownDrainSeconds > 0 ? ` the current job in ${config.shutdownDrainSeconds}s if it is still running` : " the current job"} and handing it back`);
    stopping = true;
    shutdown.abort();
  });
}

async function aiVideoLoop() {
  while (!stopping) {
    try {
      aiBusy = true;
      // A presenter kit's face crop first (ADR 0056): a composed take may be waiting for it.
      const kit = await processPresenterKit(s3, config.s3Bucket).catch(() => { console.error("presenter: face crop temporarily unavailable"); return false; });
      if (await processAiVideo(s3, config.s3Bucket) || kit) lastWorkAt = Date.now();
    } catch {
      console.error("ai-video: processing temporarily unavailable");
    } finally { aiBusy = false; }
    await sleep(5000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
}

const loops = [
  aiVideoLoop(),
  outboxLoop(),
  pollLoop(
    "render-queue",
    config.queueUrl,
    (delivery) =>
      handleDelivery(
        {
          store,
          config,
          aiSteps,
          shutdown: shutdown.signal,
          render: (job, onProgress, scope) => renderJob(job, s3, config.s3Bucket, onProgress, config.renderConcurrency, scope),
        },
        delivery,
      ),
    // Only the render loop decides the task is idle; the outbox loop never has work of its own.
    true,
  ),
];
if (config.deadLetterQueueUrl) {
  loops.push(pollLoop("dead-letter-queue", config.deadLetterQueueUrl, (delivery) => handleDeadLetter({ store, config, aiSteps }, delivery)));
}

Promise.all(loops)
  .then(async () => {
    health.close();
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
