import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { claimAiGeneration, failAiGeneration, prisma } from "@reelwalk/db";
import { VertexError, VertexVideo } from "./vertex-video";
import { aiThumbnail } from "./ai-thumbnail";
import { aiFrames, keyframes, type DecodedFrame } from "./ai-frames";
import { VertexImages, type InlineImage } from "./vertex-images";
import { fetchVideo, pollLipsync, startLipsync, synthesiseLine, voiceConfigured, voicedPrompt } from "./voice";
import { transcribeVideo, transcriptionAvailable } from "./transcribe";
import { aiShotSchema, clipSchema, insertAiShot, timelineSchema, type AiShot } from "@reelwalk/core";

let provider: VertexVideo | undefined;
let images: VertexImages | undefined;
const inline = (frame?: DecodedFrame): InlineImage | undefined => frame && { bytesBase64Encoded: frame.bytesBase64Encoded, mimeType: frame.mimeType };
type Job = NonNullable<Awaited<ReturnType<typeof claimAiGeneration>>>;
const LIPSYNC = "lipsync:";

/** The spoken line and voice mode of a take, when it has one (ADR 0038). */
function voiceOf(shot: AiShot | undefined): { line: string; mode: "lipsync" | "veo" } | null {
  return shot?.line && shot.voice ? { line: shot.line, mode: shot.voice } : null;
}

export async function processAiVideo(s3: S3Client, bucket: string): Promise<boolean> {
  // Recover an interrupted submission conservatively: don't submit it again.
  const stale = await prisma.aiGeneration.findFirst({ where: { status: "SUBMITTING", leaseUntil: { lt: new Date() } } });
  if (stale) {
    await failAiGeneration(prisma, stale.id, "Generation was interrupted. Your credit was returned; please try again.");
    return true;
  }
  const job = await claimAiGeneration(prisma);
  if (!job) return false;
  const shot = aiShotSchema.safeParse(job.shot);
  const voice = voiceOf(shot.success ? shot.data : undefined);
  try {
    provider ??= new VertexVideo(undefined, undefined, s3.config.credentials);
    if (job.status === "SUBMITTING") {
      let image: InlineImage | undefined, lastFrame: InlineImage | undefined;
      if (job.frameSources) {
        let frames: ReturnType<typeof keyframes>;
        try {
          frames = keyframes(await aiFrames(s3, bucket, job.frameSources));
        } catch {
          await failAiGeneration(prisma, job.id, "The source frames could not be read. Your credit was returned.", true);
          return true;
        }
        image = inline(frames.image); lastFrame = inline(frames.lastFrame);
        // Composed keyframes (ADR 0036): the presenter placed into the real frame before Veo sees it.
        if (frames.presenter && (frames.image?.compose || frames.lastFrame?.compose)) {
          try {
            images ??= new VertexImages(undefined, undefined, s3.config.credentials);
            for (const [end, frame] of [["first", frames.image], ["last", frames.lastFrame]] as const) {
              if (!frame?.compose) continue;
              const composed = await images.compose(end, frame.compose, inline(frame)!, inline(frames.presenter)!);
              // Kept beside the take so the studio can see what Veo was given.
              await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `workspaces/${job.workspaceId}/ai/${job.id}-${end}.jpg`, Body: Buffer.from(composed.bytesBase64Encoded, "base64"), ContentType: "image/jpeg" }));
              if (end === "first") image = composed; else lastFrame = composed;
            }
          } catch {
            await failAiGeneration(prisma, job.id, "The start and end stills could not be composed. Your credit was returned.", true);
            return true;
          }
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
      if (voice?.mode === "lipsync" && !voiceConfigured()) {
        await failAiGeneration(prisma, job.id, "Voiced shots are not available yet. Your credit was returned.", true);
        return true;
      }
      const prompt = voice ? voicedPrompt(job.prompt, voice.line, voice.mode) : job.prompt;
      const operationName = await provider.submit(job.model, job.durationSeconds, prompt, image, lastFrame, voice?.mode === "veo");
      await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "SUBMITTING" }, data: {
        status: "RUNNING", operationName, nextPollAt: new Date(Date.now() + 15_000), leaseToken: null, leaseUntil: null,
      } });
    } else {
      if (!job.operationName) throw new Error("Missing video operation.");
      if (Date.now() - job.createdAt.getTime() > 60 * 60_000) {
        await failAiGeneration(prisma, job.id, "Google took too long to return this shot. Your credit was returned.");
        return true;
      }
      if (job.operationName.startsWith(LIPSYNC)) {
        // The voice stage: the silent take and the spoken line are with sync.so.
        const status = await pollLipsync(job.operationName.slice(LIPSYNC.length));
        if (!status.done) {
          await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: { nextPollAt: new Date(Date.now() + 20_000), leaseToken: null, leaseUntil: null } });
        } else if ("url" in status) {
          await finish(s3, bucket, job, await fetchVideo(status.url), shot.success ? shot.data : undefined, voice);
        } else {
          // The take exists without the voice; keep it rather than lose a paid generation.
          console.error(`ai-video: ${job.id}: lip sync failed: ${status.error}`);
          const silent = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `workspaces/${job.workspaceId}/ai/${job.id}-silent.mp4` }));
          await finish(s3, bucket, job, Buffer.from(await silent.Body!.transformToByteArray()), shot.success ? shot.data : undefined, null, "silent");
        }
        return true;
      }
      const result = await provider.poll(job.model, job.operationName);
      if (result.error) {
        await failAiGeneration(prisma, job.id, result.error);
      } else if (result.video) {
        if (voice?.mode === "lipsync") await startVoice(s3, bucket, job, result.video, voice.line);
        else await finish(s3, bucket, job, result.video, shot.success ? shot.data : undefined, voice);
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

/** Speak the line in the fixed voice, hand the silent take and the audio to sync.so, and poll it like Veo. */
async function startVoice(s3: S3Client, bucket: string, job: Job, silent: Buffer, line: string) {
  const prefix = `workspaces/${job.workspaceId}/ai/${job.id}`;
  const audio = await synthesiseLine(line);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}-silent.mp4`, Body: silent, ContentType: "video/mp4" }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}-line.mp3`, Body: audio, ContentType: "audio/mpeg" }));
  const [videoUrl, audioUrl] = await Promise.all([
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: `${prefix}-silent.mp4` }), { expiresIn: 3600 }),
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: `${prefix}-line.mp3` }), { expiresIn: 3600 }),
  ]);
  const id = await startLipsync(videoUrl, audioUrl, `reelwalk-${job.id}`);
  await prisma.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "RUNNING" }, data: {
    operationName: `${LIPSYNC}${id}`, nextPollAt: new Date(Date.now() + 20_000), leaseToken: null, leaseUntil: null,
  } });
}

/** Words with timings for a voiced take, so captions and ducking work on it like any upload. */
async function transcript(video: Buffer, id: string) {
  if (!transcriptionAvailable()) return null;
  const workdir = await mkdtemp(path.join(os.tmpdir(), `voice-${id}-`));
  try {
    const file = path.join(workdir, "take.mp4");
    await writeFile(file, video);
    return await transcribeVideo(file, workdir, 20);
  } catch (error) {
    console.warn(`ai-video: ${id}: transcript not made: ${error instanceof Error ? error.message : error}`);
    return null;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Store the take, make its thumbnail and library record, and assemble the promo draft when asked. */
async function finish(s3: S3Client, bucket: string, job: Job, video: Buffer, shot: AiShot | undefined, voice: { line: string; mode: "lipsync" | "veo" } | null, note?: "silent") {
  const objectKey = `workspaces/${job.workspaceId}/ai/${job.id}.mp4`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: video, ContentType: "video/mp4" }));
  const thumbKey = `workspaces/${job.workspaceId}/ai/${job.id}.jpg`;
  const thumbnail = await aiThumbnail(video);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: thumbKey, Body: thumbnail, ContentType: "image/jpeg" }));
  const words = voice ? await transcript(video, job.id) : null;
  await prisma.$transaction(async tx => {
    const changed = await tx.aiGeneration.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "RUNNING" }, data: {
      status: "SUCCEEDED", assetId: `ai-${job.id}`, finishedAt: new Date(), leaseToken: null, leaseUntil: null,
      ...(note === "silent" ? { error: "The voice could not be added to this take; it is saved silent." } : {}),
    } });
    if (!changed.count) return;
    await tx.mediaAsset.upsert({ where: { objectKey }, update: { thumbKey }, create: {
      id: `ai-${job.id}`, workspaceId: job.workspaceId, kind: "VIDEO", objectKey, thumbKey, previewKey: objectKey,
      contentType: "video/mp4", fileName: `AI shot — ${voice ? `"${voice.line.slice(0, 40)}"` : job.prompt.slice(0, 60)}${note === "silent" ? " (silent)" : ""}.mp4`,
      sizeBytes: BigInt(video.length), durationMs: job.durationSeconds * 1000, width: 1080, height: 1920,
      attribution: "AI-generated with Google Veo",
      ...(words ? { transcript: words as never } : {}),
    } });
    if (shot?.draftReelId) {
      const source = await tx.reel.findFirst({ where: { id: shot.draftReelId, workspaceId: job.workspaceId } });
      const parsed = timelineSchema.safeParse(source?.timeline);
      if (source && parsed.success) {
        const timeline = parsed.data;
        const clip = clipSchema.parse({ id: `ai-insert-ai-${job.id}`, assetId: `ai-${job.id}`, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: job.durationSeconds * 1000 });
        const next = insertAiShot(timeline, clip, shot);
        // A changed/deleted boundary leaves the clip in the library for review.
        if (next !== timeline) await tx.reel.upsert({ where: { id: `ai-promo-${job.id}` }, update: {}, create: {
          id: `ai-promo-${job.id}`, workspaceId: job.workspaceId, title: `${source.title.slice(0, 65)} · AI promo`,
          timeline: next, caption: source.caption,
        } });
      }
    }
  });
}
