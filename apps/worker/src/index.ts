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

let stopping = false;
let lastTickAt = Date.now();
let lastWorkAt = Date.now();
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
      } else if (idleExit && config.idleExitSeconds > 0 && Date.now() - lastWorkAt > config.idleExitSeconds * 1000) {
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

// On SIGTERM (rollout, scale-down) stop taking new work and let the current
// render finish. If the pod is killed first, the message reappears after its
// visibility timeout and another worker reclaims the job.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, finishing current job`);
    stopping = true;
    shutdown.abort();
  });
}

const loops = [
  outboxLoop(),
  pollLoop(
    "render-queue",
    config.queueUrl,
    (delivery) =>
      handleDelivery(
        { store, config, render: (job, onProgress) => renderJob(job, s3, config.s3Bucket, onProgress, config.renderConcurrency) },
        delivery,
      ),
    // Only the render loop decides the task is idle; the outbox loop never has work of its own.
    true,
  ),
];
if (config.deadLetterQueueUrl) {
  loops.push(pollLoop("dead-letter-queue", config.deadLetterQueueUrl, (delivery) => handleDeadLetter({ store, config }, delivery)));
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
