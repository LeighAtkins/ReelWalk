import { execFile, type ExecFileOptions, type ExecFileOptionsWithBufferEncoding } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BEAT_SAMPLE_RATE, detectBeats, type BeatGrid } from "@reelwalk/core";
import { getConfig } from "../config";
import { killTree, ownChild, OWN_PROCESS_GROUP, type AttemptScope } from "../lifecycle";

// Shared by the library importers.

/** How long any one ffmpeg/ffprobe call may take before it is killed: a stuck decode must not hold the render slot forever (review of 2026-10-20). */
export const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_SECONDS ?? 15 * 60) * 1000;

/** What a `run` call is part of: the attempt whose abort kills it, and a timeout of its own. */
export type RunControl = { scope?: AttemptScope; timeoutMs?: number };

/**
 * `execFile` as a promise. The child gets its own process group, and its
 * timeout and its attempt's abort take the same path (ADR 0050): the group is
 * SIGKILLed and the promise settles once the process has exited, so a stopped
 * attempt never leaves an ffmpeg running. The child is also registered with
 * the attempt's scope, which kills it if the attempt is torn down first.
 */
export function run(file: string, args: readonly string[], options?: RunControl): Promise<{ stdout: string; stderr: string }>;
export function run(file: string, args: readonly string[], options: ExecFileOptionsWithBufferEncoding & RunControl): Promise<{ stdout: Buffer; stderr: Buffer }>;
export function run(file: string, args: readonly string[], options: ExecFileOptions & { encoding?: BufferEncoding } & RunControl): Promise<{ stdout: string; stderr: string }>;
export function run(file: string, args: readonly string[], options: ExecFileOptions & RunControl & { encoding?: string | null } = {}): Promise<unknown> {
  const { scope, timeoutMs = TOOL_TIMEOUT_MS, ...execOptions } = options;
  return new Promise((resolve, reject) => {
    if (scope?.signal.aborted) return reject(scope.signal.reason);
    let stopped: Error | null = null;
    const child = execFile(
      file,
      args as string[],
      { ...execOptions, detached: OWN_PROCESS_GROUP } as ExecFileOptions,
      (error, stdout, stderr) => {
        clearTimeout(timer);
        scope?.signal.removeEventListener("abort", onAbort);
        forget();
        if (stopped) reject(stopped);
        else if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = reason;
      killTree(child, "SIGKILL");
    };
    const timer = setTimeout(() => stop(new Error(`${path.basename(file)} did not finish within ${Math.round(timeoutMs / 1000)} s and was killed`)), timeoutMs);
    const onAbort = () => stop(scope!.signal.reason as Error);
    scope?.signal.addEventListener("abort", onAbort, { once: true });
    const forget = scope ? ownChild(scope, child, path.basename(file)) : () => {};
  });
}

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

export async function probe(file: string, scope?: AttemptScope): Promise<{ width: number; height: number; codec: string; durationMs: number | null }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name:format=duration",
    "-of", "json", file,
  ], { scope });
  const data = JSON.parse(stdout) as { streams: { width: number; height: number; codec_name?: string }[]; format: { duration?: string } };
  const duration = Number(data.format.duration);
  return {
    width: data.streams[0].width,
    height: data.streams[0].height,
    codec: data.streams[0].codec_name ?? "unknown",
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
