import http from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { prisma } from "@reelwalk/db";
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

async function pollLoop(name: string, queueUrl: string, handle: (delivery: Delivery) => Promise<unknown>) {
  console.log(`${name}: polling ${queueUrl}`);
  while (!stopping) {
    lastTickAt = Date.now();
    try {
      const message = await receive(queueUrl);
      if (message) await handle(toDelivery(queueUrl, message));
    } catch (error) {
      if (stopping) break;
      console.error(`${name}: loop error, backing off`, error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  console.log(`${name}: stopped`);
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
  pollLoop("render-queue", config.queueUrl, (delivery) =>
    handleDelivery(
      { store, config, render: (job, onProgress) => renderJob(job, s3, config.s3Bucket, onProgress) },
      delivery,
    ),
  ),
];
if (config.deadLetterQueueUrl) {
  loops.push(pollLoop("dead-letter-queue", config.deadLetterQueueUrl, (delivery) => handleDeadLetter({ store }, delivery)));
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
