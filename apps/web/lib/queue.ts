import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { serializeRenderJobMessage, type RenderJobMessage } from "@reelwalk/core";

const endpoint = process.env.SQS_ENDPOINT_URL || undefined;
const queueUrl = process.env.SQS_QUEUE_URL ?? "http://localhost:9324/000000000000/render-jobs";

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? process.env.S3_REGION ?? "us-east-1",
  endpoint,
  // The local emulator accepts any credentials; on AWS the default chain applies.
  credentials: endpoint ? { accessKeyId: "local", secretAccessKey: "local" } : undefined,
});

export async function enqueueRenderJob(message: RenderJobMessage): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: serializeRenderJobMessage(message) }));
}
