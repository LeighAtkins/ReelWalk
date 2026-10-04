import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BEAT_SAMPLE_RATE, detectBeats, type BeatGrid } from "@reelwalk/core";
import { getConfig } from "../config";

// Shared by the library importers.

export const run = promisify(execFile);

const config = getConfig();
const s3 = new S3Client({
  endpoint: config.s3EndpointUrl,
  region: config.s3Region,
  forcePathStyle: config.s3ForcePathStyle,
  credentials:
    config.s3AccessKeyId && config.s3SecretAccessKey
      ? { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey }
      : undefined,
});

export async function upload(key: string, file: string, contentType: string): Promise<number> {
  const { size } = await stat(file);
  await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: contentType }));
  return size;
}

export async function probe(file: string): Promise<{ width: number; height: number; durationMs: number | null }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", file,
  ]);
  const data = JSON.parse(stdout) as { streams: { width: number; height: number }[]; format: { duration?: string } };
  const duration = Number(data.format.duration);
  return {
    width: data.streams[0].width,
    height: data.streams[0].height,
    durationMs: Number.isFinite(duration) && duration > 0.2 ? Math.round(duration * 1000) : null,
  };
}

/**
 * Tempo of a song. ffmpeg decodes the first 90 seconds to raw mono samples,
 * and the same detector the browser uses for uploads does the rest.
 */
export async function analyseBeats(file: string): Promise<BeatGrid | null> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-t", "90", "-i", file, "-ac", "1", "-ar", String(BEAT_SAMPLE_RATE), "-f", "f32le", "pipe:1"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  // Copied: a Buffer may start at an offset a Float32Array cannot be aligned to.
  const bytes = Math.floor(stdout.byteLength / 4) * 4;
  const samples = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + bytes));
  return detectBeats(samples);
}

/**
 * Thumbnail for a 360 photo: the view a 9:16 camera has looking straight
 * ahead, not the warped 2:1 strip.
 */
export async function panoThumbnail(source: string, destination: string): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-y", "-i", source, "-vf", "v360=e:flat:h_fov=59:v_fov=90:w=270:h=480", "-q:v", "5", destination]);
}
