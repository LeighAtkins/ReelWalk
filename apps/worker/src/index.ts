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
import { handOffLocalRender, LOCAL_RENDER_JOBS_TOPIC, prisma, relayOutbox, RENDER_JOBS_TOPIC } from "@reelwalk/db";
import { getConfig } from "./config";
import { handleDeadLetter, handleDelivery, type Delivery } from "./handler";
import { renderJob } from "./render";
import { createJobStore } from "./store";
import { processAiVideo } from "./ai-video";
import { processPresenterKit } from "./presenter-kits";
import { AI_STEP_QUEUE_RETENTION_MS, AI_STEP_REAP_AFTER_MS, serializeRenderJobMessage } from "@reelwalk/core";
import { createAiStepStore, type AiStepDeps } from "./ai-jobs";
import { aiStepExecutor } from "./ai-executor";
import { checkHeavyLockDir, createHeavyLock } from "./heavy-lock";
import { handleLocalDelivery } from "./local-delivery";

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
// A local worker (ADR 0094) shares the PC: each render waits for the machine-wide heavy lock.
const heavyLock = config.heavyLockDir
  ? createHeavyLock({ dir: config.heavyLockDir, owner: config.heavyLockOwner, cooldownMs: Number(process.env.HEAVY_LOCK_COOLDOWN_SECONDS ?? 60) * 1000 })
  : undefined;
if (config.heavyLockDir) await checkHeavyLockDir(config.heavyLockDir);
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

// Which outbox topics this worker relays, and where to. A local worker (ADR 0094) consumes the local
// queue as its queueUrl and relays only local messages; a cloud worker relays both.
const relays: { topic: string; queueUrl: string }[] = config.mode === "local"
  ? [{ topic: LOCAL_RENDER_JOBS_TOPIC, queueUrl: config.queueUrl }]
  : [{ topic: RENDER_JOBS_TOPIC, queueUrl: config.queueUrl }, { topic: LOCAL_RENDER_JOBS_TOPIC, queueUrl: config.localQueueUrl ?? config.queueUrl }];

async function outboxLoop() {
  for (const relay of relays) console.log(`outbox: relaying ${relay.topic} to ${relay.queueUrl}`);
  while (!stopping) {
    for (const relay of relays) {
      try {
        const { sent, failed } = await relayOutbox(prisma, {
          topic: relay.topic,
          send: async (body) => {
            await sqs.send(new SendMessageCommand({ QueueUrl: relay.queueUrl, MessageBody: body }), {
              abortSignal: AbortSignal.timeout(10_000),
            });
          },
        });
        if (sent > 0 || failed > 0) console.log(`outbox: ${relay.topic} sent ${sent}, failed ${failed}`);
      } catch (error) {
        if (stopping) break;
        console.error("outbox: relay error", error);
      }
    }
    if (config.mode === "cloud") await reapAiSteps();
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
  // AI video needs Google credentials only the cloud worker has; a local worker renders only (ADR 0094).
  ...(config.mode === "cloud" ? [aiVideoLoop()] : []),
  outboxLoop(),
  pollLoop(
    "render-queue",
    config.queueUrl,
    (delivery) => {
      const handle = (received: Delivery) =>
        handleDelivery(
          {
            store,
            config,
            aiSteps,
            shutdown: shutdown.signal,
            render: (job, onProgress, scope) => renderJob(job, s3, config.s3Bucket, onProgress, config.renderConcurrency, scope),
          },
          received,
        );
      // A local worker waits for the shared-PC lock before claiming, and hands the job to the cloud if the wait is too long (ADR 0094).
      if (!heavyLock) return handle(delivery);
      return handleLocalDelivery({
        lock: heavyLock,
        waitMs: config.heavyLockWaitSeconds * 1000,
        keepHiddenMs: config.heartbeatSeconds * 1000,
        visibilitySeconds: config.visibilitySeconds,
        handOff: (message) => handOffLocalRender(prisma, message, serializeRenderJobMessage),
        handle,
        shutdown: shutdown.signal,
      }, delivery);
    },
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
