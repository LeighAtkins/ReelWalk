/**
 * Queues a PREVIEW job for every uploaded video that has no 720p rendition
 * yet. Run once after deploying preview renditions, or after a bulk import.
 *
 *   DATABASE_URL=... RENDER_JOBS_QUEUE_URL=... AWS_PROFILE=reelwalk pnpm --filter @reelwalk/worker exec tsx scripts/backfill-previews.ts
 *
 * The job and its queue message go into the database together (outbox), then
 * the message is sent. Start a worker afterwards if none is running.
 */
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { serializeRenderJobMessage } from "@reelwalk/core";
import { addToOutbox, prisma, relayOutbox, RENDER_JOBS_TOPIC } from "@reelwalk/db";

const queueUrl = process.env.RENDER_JOBS_QUEUE_URL;
if (!queueUrl) throw new Error("RENDER_JOBS_QUEUE_URL is required");
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-2" });

const assets = await prisma.mediaAsset.findMany({
  where: { kind: "VIDEO", previewKey: null, renderJobs: { none: { kind: "PREVIEW", status: { in: ["QUEUED", "RUNNING"] } } } },
  select: { id: true, workspaceId: true, fileName: true },
});
for (const asset of assets) {
  await prisma.$transaction(async (tx) => {
    const job = await tx.renderJob.create({
      data: { workspaceId: asset.workspaceId, mediaAssetId: asset.id, kind: "PREVIEW", caption: asset.fileName },
    });
    await addToOutbox(tx, RENDER_JOBS_TOPIC, serializeRenderJobMessage({ jobId: job.id, generation: job.generation }));
  });
  console.log(`queued preview for ${asset.id} (${asset.fileName})`);
}
const { sent, failed } = await relayOutbox(prisma, {
  topic: RENDER_JOBS_TOPIC,
  send: async (body) => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
  },
});
console.log(`${assets.length} job(s) queued, ${sent} message(s) sent, ${failed} failed`);
await prisma.$disconnect();
