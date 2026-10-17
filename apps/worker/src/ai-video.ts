import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { claimAiGeneration, failAiGeneration, prisma } from "@reelwalk/db";
import { VertexError, VertexVideo } from "./vertex-video";

let provider: VertexVideo | undefined;

export async function processAiVideo(s3: S3Client, bucket: string): Promise<boolean> {
  // Recover an interrupted submission conservatively: don't submit it again.
  const stale = await prisma.aiGeneration.findFirst({ where: { status: "SUBMITTING", leaseUntil: { lt: new Date() } } });
  if (stale) {
    await failAiGeneration(prisma, stale.id, "Generation was interrupted. Your credit was returned; please try again.");
    return true;
  }
  const job = await claimAiGeneration(prisma);
  if (!job) return false;
  try {
    provider ??= new VertexVideo(undefined, undefined, s3.config.credentials);
    if (job.status === "SUBMITTING") {
      let image;
      if (job.referenceKey) {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: job.referenceKey }));
        if (!result.Body || (result.ContentLength ?? 0) > 20 * 1024 * 1024) {
          await failAiGeneration(prisma, job.id, "That photo could not be read. Your credit was returned.", true);
          return true;
        }
        const bytes = await result.Body.transformToByteArray();
        image = { bytesBase64Encoded: Buffer.from(bytes).toString("base64"), mimeType: job.referenceType! };
      }
      const operationName = await provider.submit(job.model, job.prompt, image);
      await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "SUBMITTING" }, data: {
        status: "RUNNING", operationName, nextPollAt: new Date(Date.now() + 15_000), leaseToken: null, leaseUntil: null,
      } });
    } else {
      if (!job.operationName) throw new Error("Missing video operation.");
      if (Date.now() - job.createdAt.getTime() > 60 * 60_000) {
        await failAiGeneration(prisma, job.id, "Google took too long to return this shot. Your credit was returned.");
        return true;
      }
      const result = await provider.poll(job.model, job.operationName);
      if (result.error) {
        await failAiGeneration(prisma, job.id, result.error);
      } else if (result.video) {
        const objectKey = `workspaces/${job.workspaceId}/ai/${job.id}.mp4`;
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: result.video, ContentType: "video/mp4" }));
        await prisma.$transaction(async tx => {
          const changed = await tx.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "RUNNING" }, data: {
            status: "SUCCEEDED", assetId: `ai-${job.id}`, finishedAt: new Date(), leaseToken: null, leaseUntil: null,
          } });
          if (!changed.count) return;
          await tx.mediaAsset.upsert({ where: { objectKey }, update: {}, create: {
            id: `ai-${job.id}`, workspaceId: job.workspaceId, kind: "VIDEO", objectKey, previewKey: objectKey,
            contentType: "video/mp4", fileName: `AI shot — ${job.prompt.slice(0, 60)}.mp4`,
            sizeBytes: BigInt(result.video!.length), durationMs: 8000, width: 1080, height: 1920,
            attribution: "AI-generated with Google Veo",
          } });
        });
      } else {
        if (Date.now() - job.createdAt.getTime() > 60 * 60_000) {
          await failAiGeneration(prisma, job.id, "Google took too long to return this shot. Your credit was returned.");
        } else await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: {
          nextPollAt: new Date(Date.now() + 15_000), leaseToken: null, leaseUntil: null,
        } });
      }
    }
  } catch (error) {
    if (job.status === "SUBMITTING") {
      await failAiGeneration(prisma, job.id, "The video service could not start this shot. Your credit was returned.",
        error instanceof VertexError && error.status >= 400 && error.status < 500 && error.status !== 408);
    } else {
      // Poll/import failures retry the saved operation, never a new generation.
      await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: {
        nextPollAt: new Date(Date.now() + 30_000), leaseToken: null, leaseUntil: null,
      } });
    }
    console.error(`ai-video: ${job.id}: ${error instanceof VertexError ? error.message : "temporary processing error"}`);
  }
  return true;
}
