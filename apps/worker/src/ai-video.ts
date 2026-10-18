import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { claimAiGeneration, failAiGeneration, prisma } from "@reelwalk/db";
import { VertexError, VertexVideo } from "./vertex-video";
import { aiThumbnail } from "./ai-thumbnail";
import { aiFrames } from "./ai-frames";
import { aiShotSchema, clipSchema, insertAiShot, timelineSchema } from "@reelwalk/core";

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
      let image, lastFrame;
      if (job.frameSources) {
        try {
          [image, lastFrame] = await aiFrames(s3, bucket, job.frameSources);
        } catch {
          await failAiGeneration(prisma, job.id, "The source frames could not be read. Your credit was returned.", true);
          return true;
        }
      } else if (job.referenceKey) {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: job.referenceKey }));
        if (!result.Body || (result.ContentLength ?? 0) > 20 * 1024 * 1024) {
          await failAiGeneration(prisma, job.id, "That photo could not be read. Your credit was returned.", true);
          return true;
        }
        const bytes = await result.Body.transformToByteArray();
        image = { bytesBase64Encoded: Buffer.from(bytes).toString("base64"), mimeType: job.referenceType! };
      }
      const operationName = await provider.submit(job.model, job.durationSeconds, job.prompt, image, lastFrame);
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
        const thumbKey = `workspaces/${job.workspaceId}/ai/${job.id}.jpg`;
        const thumbnail = await aiThumbnail(result.video);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: thumbKey, Body: thumbnail, ContentType: "image/jpeg" }));
        await prisma.$transaction(async tx => {
          const changed = await tx.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "RUNNING" }, data: {
            status: "SUCCEEDED", assetId: `ai-${job.id}`, finishedAt: new Date(), leaseToken: null, leaseUntil: null,
          } });
          if (!changed.count) return;
          await tx.mediaAsset.upsert({ where: { objectKey }, update: { thumbKey }, create: {
            id: `ai-${job.id}`, workspaceId: job.workspaceId, kind: "VIDEO", objectKey, thumbKey, previewKey: objectKey,
            contentType: "video/mp4", fileName: `AI shot — ${job.prompt.slice(0, 60)}.mp4`,
            sizeBytes: BigInt(result.video!.length), durationMs: job.durationSeconds * 1000, width: 1080, height: 1920,
            attribution: "AI-generated with Google Veo",
          } });
          const shot = aiShotSchema.safeParse(job.shot);
          if (shot.success && shot.data.draftReelId) {
            const source = await tx.reel.findFirst({ where: { id: shot.data.draftReelId, workspaceId: job.workspaceId } });
            const parsed = timelineSchema.safeParse(source?.timeline);
            if (source && parsed.success) {
              const timeline = parsed.data;
              const clip = clipSchema.parse({ id: `ai-insert-ai-${job.id}`, assetId: `ai-${job.id}`, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: job.durationSeconds * 1000 });
              const next = insertAiShot(timeline, clip, shot.data);
              // A changed/deleted boundary leaves the clip in the library for review.
              if (next !== timeline) await tx.reel.upsert({ where: { id: `ai-promo-${job.id}` }, update: {}, create: {
                id: `ai-promo-${job.id}`, workspaceId: job.workspaceId, title: `${source.title.slice(0, 65)} · AI promo`,
                timeline: next, caption: source.caption,
              } });
            }
          }
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
