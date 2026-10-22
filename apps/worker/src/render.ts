import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { checksKeyFor, exportAudioKeyFor, frameThumbKeyFor, inputFilenameFor, outputKeyFor, parseReelExportPayload, reelRenderPlan, renderSourceKeyFor, type RenderChecks } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { probe, run } from "./library/tools";
import { createAttemptScope, killDescendants, REMOTION_PROCESSES, type AttemptScope } from "./lifecycle";
import { measureExportAudio, normaliseLoudness } from "./loudness";
import { transcribeVideo, transcriptionAvailable } from "./transcribe";
import { verifyRender } from "./verify";

/** Longest side of a clip the renderer is handed. Output is 1080x1920, so nothing is lost. */
const MAX_RENDER_SIDE = 1920;

/**
 * Which object the renderer should read for a video: the original when it is
 * H.264 at 1080p or smaller, otherwise an H.264 1080p copy made once and kept.
 * Phones record HEVC, which headless Chrome cannot decode with WebCodecs;
 * Remotion then falls back to software decoding in its compositor, which is
 * slow and was what ran the worker out of memory.
 */
async function renderSourceKey(
  s3: S3Client,
  bucket: string,
  workdir: string,
  assetId: string,
  objectKey: string,
  log: (line: string) => void,
  scope: AttemptScope,
  /** The original, when it is already on disk. */
  localPath?: string,
): Promise<string> {
  const key = renderSourceKeyFor(assetId);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: scope.signal });
    return key;
  } catch {
    // Not made yet.
  }
  scope.throwIfStopped();
  const inputPath = localPath ?? path.join(workdir, `src-${inputFilenameFor(objectKey)}`);
  if (!localPath) await downloadObject(s3, bucket, objectKey, inputPath, scope.signal);
  const { width, height, codec } = await probe(inputPath, scope);
  if (codec === "h264" && Math.max(width, height) <= MAX_RENDER_SIDE) {
    if (!localPath) await rm(inputPath, { force: true });
    return objectKey;
  }
  log(`re-encode ${codec} ${width}x${height} ${objectKey} -> ${key}`);
  const outPath = path.join(workdir, `render-${assetId}.mp4`);
  await run("ffmpeg", [
    "-v", "error", "-y", "-i", inputPath,
    "-vf", `scale='if(gt(iw,ih),min(${MAX_RENDER_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_RENDER_SIDE},ih))'`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outPath,
  ], { scope });
  const { size } = await stat(outPath);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(outPath), ContentLength: size, ContentType: "video/mp4" }), { abortSignal: scope.signal });
  if (!localPath) await rm(inputPath, { force: true });
  await rm(outPath, { force: true });
  return key;
}
import { sfxAssets } from "@reelwalk/render/reel-sfx";
import type { ReelAsset } from "@reelwalk/render/reel-types";
import { renderStubReel } from "@reelwalk/render/render-job";
import { preflightReel, renderReel } from "@reelwalk/render/render-reel";
import type { ClaimedJob, RenderResult } from "./handler";

/**
 * A 240 px high JPEG of a representative frame: ffmpeg's thumbnail filter
 * picks the most typical of the frames from half a second to 3.5 s in, so a
 * fade from black or a hand over the lens is passed over. Short clips start
 * at their first frame.
 */
export async function frameThumbnail(videoPath: string, outPath: string, scope?: AttemptScope): Promise<void> {
  const args = (start: number) => ["-v", "error", "-y", "-ss", String(start), "-t", "3", "-i", videoPath, "-vf", "thumbnail=45,scale=-2:240", "-frames:v", "1", "-q:v", "4", outPath];
  try {
    await run("ffmpeg", args(0.5), { scope });
    await stat(outPath);
  } catch {
    scope?.throwIfStopped();
    await run("ffmpeg", args(0), { scope });
  }
}

async function downloadObject(client: S3Client, bucket: string, key: string, destination: string, signal: AbortSignal) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
  if (!result.Body) throw new Error(`No body returned for ${key}`);
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(destination), { signal });
}

/**
 * Renders one job to MP4 and uploads it. The output key is derived from the
 * job id and attempt, so a retry never overwrites another attempt's file.
 *
 * Everything long-running is tied to `scope` (ADR 0050): S3 calls and ffmpeg
 * take its signal, Remotion is cancelled through it, and the work dir and any
 * Chrome Remotion leaves behind are owned by it. The caller closes the scope;
 * without one, a private scope is made and closed here.
 */
export async function renderJob(
  job: ClaimedJob,
  s3: S3Client,
  bucket: string,
  onProgress: (percent: number) => void,
  concurrency?: number,
  scope?: AttemptScope,
): Promise<RenderResult> {
  const privateScope = scope ? null : createAttemptScope();
  const attempt = scope ?? privateScope!;
  const signal = attempt.signal;
  const workdir = await attempt.tempDir(`reelwalk-${job.id}-`);
  const outputPath = path.join(workdir, "output.mp4");
  const report = (fraction: number) => onProgress(Math.min(100, Math.round(fraction * 100)));
  // The render checks (ADR 0071), stored beside a reel export; null when they could not be made.
  let checks: RenderChecks | null = null;
  // The export's measured audio (ADR 0066), uploaded beside the MP4.
  let exportAudio: Buffer | null = null;

  try {
    if (job.kind === "PREVIEW") {
      if (!job.inputKey || !job.previewKey || !job.mediaAssetId) throw new Error("The uploaded video for this preview was deleted");
      const inputPath = path.join(workdir, inputFilenameFor(job.inputKey));
      console.log(`[${job.id}] download s3://${bucket}/${job.inputKey}`);
      await downloadObject(s3, bucket, job.inputKey, inputPath, signal);
      report(0.2);
      // 720 px on the short side, 30 fps, H.264 + AAC, moov atom first so the
      // browser can start before the whole file arrives.
      await run("ffmpeg", [
        "-v", "error", "-y", "-i", inputPath,
        "-vf", "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'",
        "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", outputPath,
      ], { scope: attempt });
      report(0.9);
      const { size: previewSize } = await stat(outputPath);
      console.log(`[${job.id}] upload ${previewSize} bytes to s3://${bucket}/${job.previewKey}`);
      // The key never gets new content, so browsers may keep it for a year.
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: job.previewKey,
          Body: createReadStream(outputPath),
          ContentLength: previewSize,
          ContentType: "video/mp4",
          CacheControl: "public, max-age=31536000, immutable",
        }),
        { abortSignal: signal },
      );
      // The thumbnail from a real frame, in place of the browser's (which can be black).
      let thumbKey: string | null = null;
      try {
        const thumbPath = path.join(workdir, "thumb.jpg");
        await frameThumbnail(outputPath, thumbPath, attempt);
        const { size: thumbSize } = await stat(thumbPath);
        thumbKey = frameThumbKeyFor(job.inputKey);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: thumbKey, Body: createReadStream(thumbPath), ContentLength: thumbSize, ContentType: "image/jpeg" }), { abortSignal: signal });
      } catch (error) {
        attempt.throwIfStopped();
        thumbKey = null;
        console.warn(`[${job.id}] frame thumbnail not made: ${error instanceof Error ? error.message : error}`);
      }
      // What it says, with word timings, so captions can sit on the words (ADR 0035).
      let transcript = null;
      if (transcriptionAvailable()) {
        try {
          transcript = await transcribeVideo(inputPath, workdir, undefined, attempt);
          console.log(`[${job.id}] transcript: ${transcript ? `${transcript.words.length} words` : "no speech"}`);
        } catch (error) {
          attempt.throwIfStopped();
          console.warn(`[${job.id}] transcript not made: ${error instanceof Error ? error.message : error}`);
        }
      }
      attempt.throwIfStopped();
      await prisma.mediaAsset.update({ where: { id: job.mediaAssetId }, data: { previewKey: job.previewKey, ...(thumbKey ? { thumbKey } : {}), ...(transcript ? { transcript: transcript as never } : {}) } });
      // While the original is here, make the copy an export will need, so the
      // first export of phone footage does not spend minutes re-encoding.
      // An export makes it itself if this fails.
      try {
        await renderSourceKey(s3, bucket, workdir, job.mediaAssetId, job.inputKey, (line) => console.log(`[${job.id}] ${line}`), attempt, inputPath);
      } catch (error) {
        attempt.throwIfStopped();
        console.warn(`[${job.id}] render source not made ahead: ${error instanceof Error ? error.message : error}`);
      }
      return { objectKey: job.previewKey, contentType: "video/mp4", sizeBytes: previewSize };
    }
    if (job.kind === "REEL" || job.kind === "STORY" || job.kind === "TEMPLATE") {
      // Remotion closes the Chrome it opened without waiting for it, also when cancelled: whatever is left
      // of it when the attempt ends is stopped then (SIGTERM, the grace, SIGKILL).
      attempt.own("remotion processes", (remainingMs) => killDescendants({ match: REMOTION_PROCESSES, graceMs: remainingMs }));
    }
    // A story cut (ADR 0065) is a reel export of a derived timeline: the same path.
    if (job.kind === "REEL" || job.kind === "STORY") {
      const payload = parseReelExportPayload(job.payload);
      // An Instagram sound is never baked into the MP4 (ADR 0019): the plan
      // drops it, and Instagram attaches the sound itself when the reel is posted.
      const plan = reelRenderPlan(payload);
      if (plan.timeline.music === null && payload.timeline.music !== null) console.log(`[${job.id}] music is an Instagram sound; rendering without it`);
      // Headless Chrome fetches the media straight from storage, so it gets
      // short-lived signed URLs instead of the files being copied first.
      const assets: Record<string, ReelAsset> = {};
      const entries = Object.entries(plan.assets);
      for (const [index, [id, asset]] of entries.entries()) {
        const key = asset.kind === "VIDEO" ? await renderSourceKey(s3, bucket, workdir, id, asset.objectKey, (line) => console.log(`[${job.id}] ${line}`), attempt) : asset.objectKey;
        const src = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
        assets[id] = { src, kind: asset.kind, ...(asset.transcript ? { transcript: asset.transcript } : {}) };
        // Preparing sources is the first fifth of the bar; Remotion reports the rest.
        report(((index + 1) / entries.length) * 0.2);
      }
      // The bundled sound design files (ADR 0066), served by the bundle's public dir.
      Object.assign(assets, sfxAssets(plan.timeline));
      // Draw the first and last frame of every shot first (ADR 0042): a frame that
      // errors or hangs fails in seconds, naming the shot, not minutes into the render.
      if (process.env.RENDER_PREFLIGHT !== "0") {
        const started = Date.now();
        await preflightReel({ timeline: plan.timeline, assets, signal }, (done, total) => report(0.2 + 0.08 * (done / total)));
        console.log(`[${job.id}] preflight: every shot drew (${Math.round((Date.now() - started) / 1000)} s)`);
      }
      await renderReel({ timeline: plan.timeline, assets, output: outputPath, concurrency, width: payload.output.width, watermark: payload.output.watermark, signal }, report);
      await normaliseLoudness(outputPath, (line) => console.log(`[${job.id}] ${line}`), attempt);
      if (process.env.RENDER_CHECKS !== "0") {
        try {
          checks = await verifyRender(outputPath, plan.timeline, (line) => console.log(`[${job.id}] ${line}`), attempt);
        } catch (error) {
          attempt.throwIfStopped();
          console.warn(`[${job.id}] checks not made: ${error instanceof Error ? error.message : error}`);
        }
      }
      // What the finished track holds (ADR 0066), for the export page's mix preview and the audio trace. Best effort.
      try {
        const audio = await measureExportAudio(outputPath, attempt);
        if (audio) {
          exportAudio = Buffer.from(JSON.stringify(audio));
          console.log(`[${job.id}] audio: ${audio.integratedLufs ?? "silent"} LUFS integrated, ${audio.truePeakDb ?? "-"} dBTP, ${audio.lufs.length} steps`);
        }
      } catch (error) {
        attempt.throwIfStopped();
        console.warn(`[${job.id}] audio not measured: ${error instanceof Error ? error.message : error}`);
      }
    } else if (job.kind === "EDITOR") {
      // Editor projects carried media URLs chosen by the client, so rendering
      // one made the worker fetch any host it named (SSRF). The route that
      // queued them is gone; refuse any still in the queue.
      throw new Error("Editor-project renders are no longer supported");
    } else {
      if (!job.inputKey) throw new Error("The source media for this render was deleted");
      const inputPath = path.join(workdir, inputFilenameFor(job.inputKey));
      console.log(`[${job.id}] download s3://${bucket}/${job.inputKey}`);
      await downloadObject(s3, bucket, job.inputKey, inputPath, signal);
      await renderStubReel(
        { input: inputPath, output: outputPath, caption: job.caption ?? undefined, brand: job.brand ?? undefined },
        report,
        signal,
      );
    }

    // Each attempt uploads to its own key: a worker that was declared stale and finishes late cannot
    // overwrite the file the job's current attempt published (the output row names the key that won).
    const objectKey = outputKeyFor(job.id, job.attempt);
    if (exportAudio) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: exportAudioKeyFor(objectKey), Body: exportAudio, ContentLength: exportAudio.byteLength, ContentType: "application/json" }), { abortSignal: signal });
    }
    const { size } = await stat(outputPath);
    console.log(`[${job.id}] upload ${size} bytes to s3://${bucket}/${objectKey}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: createReadStream(outputPath),
        ContentLength: size,
        ContentType: "video/mp4",
      }),
      { abortSignal: signal },
    );
    if (checks) {
      // Beside the file, under the file's own key: a retry's new file gets new checks, and a stale worker's cannot replace them.
      const checksKey = checksKeyFor(objectKey);
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: checksKey, Body: Buffer.from(JSON.stringify(checks)), ContentType: "application/json" }), { abortSignal: signal });
      } catch (error) {
        attempt.throwIfStopped();
        console.warn(`[${job.id}] checks not stored at ${checksKey}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { objectKey, contentType: "video/mp4", sizeBytes: size };
  } finally {
    await privateScope?.close();
  }
}
