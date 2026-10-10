import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { inputFilenameFor, outputKeyFor, parseReelExportPayload, renderSourceKeyFor } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { probe, run } from "./library/tools";

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
  /** The original, when it is already on disk. */
  localPath?: string,
): Promise<string> {
  const key = renderSourceKeyFor(assetId);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return key;
  } catch {
    // Not made yet.
  }
  const inputPath = localPath ?? path.join(workdir, `src-${inputFilenameFor(objectKey)}`);
  if (!localPath) await downloadObject(s3, bucket, objectKey, inputPath);
  const { width, height, codec } = await probe(inputPath);
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
  ]);
  const { size } = await stat(outPath);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(outPath), ContentLength: size, ContentType: "video/mp4" }));
  if (!localPath) await rm(inputPath, { force: true });
  await rm(outPath, { force: true });
  return key;
}
import type { ReelAsset } from "@reelwalk/render/reel-types";
import { renderStubReel } from "@reelwalk/render/render-job";
import { renderReel } from "@reelwalk/render/render-reel";
import type { ClaimedJob, RenderResult } from "./handler";

async function downloadObject(client: S3Client, bucket: string, key: string, destination: string) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`No body returned for ${key}`);
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(destination));
}

/**
 * Renders one job to MP4 and uploads it. The output key is derived from the
 * job id, so running this twice for the same job overwrites one object.
 */
export async function renderJob(
  job: ClaimedJob,
  s3: S3Client,
  bucket: string,
  onProgress: (percent: number) => void,
  concurrency?: number,
): Promise<RenderResult> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), `reelwalk-${job.id}-`));
  const outputPath = path.join(workdir, "output.mp4");
  const report = (fraction: number) => onProgress(Math.min(100, Math.round(fraction * 100)));

  try {
    if (job.kind === "PREVIEW") {
      if (!job.inputKey || !job.previewKey || !job.mediaAssetId) throw new Error("The uploaded video for this preview was deleted");
      const inputPath = path.join(workdir, inputFilenameFor(job.inputKey));
      console.log(`[${job.id}] download s3://${bucket}/${job.inputKey}`);
      await downloadObject(s3, bucket, job.inputKey, inputPath);
      report(0.2);
      // 720 px on the short side, 30 fps, H.264 + AAC, moov atom first so the
      // browser can start before the whole file arrives.
      await run("ffmpeg", [
        "-v", "error", "-y", "-i", inputPath,
        "-vf", "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'",
        "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", outputPath,
      ]);
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
      );
      await prisma.mediaAsset.update({ where: { id: job.mediaAssetId }, data: { previewKey: job.previewKey } });
      // While the original is here, make the copy an export will need, so the
      // first export of phone footage does not spend minutes re-encoding.
      // An export makes it itself if this fails.
      try {
        await renderSourceKey(s3, bucket, workdir, job.mediaAssetId, job.inputKey, (line) => console.log(`[${job.id}] ${line}`), inputPath);
      } catch (error) {
        console.warn(`[${job.id}] render source not made ahead: ${error instanceof Error ? error.message : error}`);
      }
      return { objectKey: job.previewKey, contentType: "video/mp4", sizeBytes: previewSize };
    }
    if (job.kind === "REEL") {
      const payload = parseReelExportPayload(job.payload);
      // Headless Chrome fetches the media straight from storage, so it gets
      // short-lived signed URLs instead of the files being copied first.
      const assets: Record<string, ReelAsset> = {};
      const entries = Object.entries(payload.assets);
      for (const [index, [id, asset]] of entries.entries()) {
        const key = asset.kind === "VIDEO" ? await renderSourceKey(s3, bucket, workdir, id, asset.objectKey, (line) => console.log(`[${job.id}] ${line}`)) : asset.objectKey;
        const src = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
        assets[id] = { src, kind: asset.kind };
        // Preparing sources is the first fifth of the bar; Remotion reports the rest.
        report(((index + 1) / entries.length) * 0.2);
      }
      await renderReel({ timeline: payload.timeline, assets, output: outputPath, concurrency }, report);
    } else if (job.kind === "EDITOR") {
      // Editor projects carried media URLs chosen by the client, so rendering
      // one made the worker fetch any host it named (SSRF). The route that
      // queued them is gone; refuse any still in the queue.
      throw new Error("Editor-project renders are no longer supported");
    } else {
      if (!job.inputKey) throw new Error("The source media for this render was deleted");
      const inputPath = path.join(workdir, inputFilenameFor(job.inputKey));
      console.log(`[${job.id}] download s3://${bucket}/${job.inputKey}`);
      await downloadObject(s3, bucket, job.inputKey, inputPath);
      await renderStubReel(
        { input: inputPath, output: outputPath, caption: job.caption ?? undefined, brand: job.brand ?? undefined },
        report,
      );
    }

    const objectKey = outputKeyFor(job.id);
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
    );
    return { objectKey, contentType: "video/mp4", sizeBytes: size };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
