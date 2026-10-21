import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { analyseSong, BEAT_SAMPLE_RATE, detectBeats, type BeatGrid, type SongMap } from "@reelwalk/core";
import { getConfig } from "../config";
import { killTree, ownChild, OWN_PROCESS_GROUP, type AttemptScope } from "../lifecycle";

// Shared by the library importers.

/** How long any one ffmpeg/ffprobe call may take before it is killed: a stuck decode must not hold the render slot forever (review of 2026-10-20). */
export const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_SECONDS ?? 15 * 60) * 1000;

/** What a `run` call is part of: the attempt whose abort kills it, and a timeout of its own. */
export type RunControl = { scope?: AttemptScope; timeoutMs?: number };

type RunOptions = RunControl & { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number };

/**
 * Runs a program to completion, like `execFile` (same output, same error
 * shape with `code`, `stdout` and `stderr`), but spawned in its own process
 * group (`execFile` ignores `detached`). Its timeout and its attempt's abort
 * take the same path (ADR 0050): the group is SIGKILLed and the promise
 * settles once the process has exited, so a stopped attempt never leaves an
 * ffmpeg running. The child is also registered with the attempt's scope,
 * which kills it if the attempt is torn down first.
 */
export function run(file: string, args: readonly string[], options?: RunOptions & { encoding?: BufferEncoding }): Promise<{ stdout: string; stderr: string }>;
export function run(file: string, args: readonly string[], options: RunOptions & { encoding: "buffer" }): Promise<{ stdout: Buffer; stderr: Buffer }>;
export function run(file: string, args: readonly string[], options: RunOptions & { encoding?: BufferEncoding | "buffer" } = {}): Promise<unknown> {
  const { scope, timeoutMs = TOOL_TIMEOUT_MS, encoding = "utf8", maxBuffer = 1024 * 1024, cwd, env } = options;
  const name = path.basename(file);
  return new Promise((resolve, reject) => {
    if (scope?.signal.aborted) return reject(scope.signal.reason);
    const child = spawn(file, args, { cwd, env, detached: OWN_PROCESS_GROUP, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let stopped: Error | null = null;
    let settled = false;
    const decode = (chunks: Buffer[]) => (encoding === "buffer" ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding));
    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = reason;
      killTree(child, "SIGKILL");
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) stop(new RangeError(`${name} wrote more than ${maxBuffer} bytes of output`));
      else into.push(chunk);
    };
    child.stdout!.on("data", collect(out));
    child.stderr!.on("data", collect(err));
    const finish = (error: Error | null, code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      scope?.signal.removeEventListener("abort", onAbort);
      forget();
      const stdout = decode(out);
      const stderr = decode(err);
      if (stopped) return reject(stopped);
      if (error) return reject(Object.assign(error, { stdout, stderr }));
      if (code !== 0) {
        return reject(Object.assign(new Error(`Command failed: ${[file, ...args].join(" ")}\n${String(stderr)}`), { code, signal, stdout, stderr }));
      }
      resolve({ stdout, stderr });
    };
    child.once("error", (error) => finish(error, null, null));
    child.once("close", (code, signal) => finish(null, code, signal));
    const timer = setTimeout(() => stop(new Error(`${name} did not finish within ${Math.round(timeoutMs / 1000)} s and was killed`)), timeoutMs);
    const onAbort = () => stop(scope!.signal.reason as Error);
    scope?.signal.addEventListener("abort", onAbort, { once: true });
    const forget = scope ? ownChild(scope, child, name) : () => {};
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
 * Tempo of a song and its structure (bars, intro/build/drop/outro, ADR 0059).
 * ffmpeg decodes the first 90 seconds to raw mono samples, and the same
 * detectors the browser uses for uploads do the rest.
 */
export async function analyseMusic(file: string): Promise<{ beat: BeatGrid | null; songMap: SongMap | null }> {
  const samples = await decodeMono(file);
  const beat = detectBeats(samples);
  return { beat, songMap: beat ? analyseSong(samples, beat) : null };
}

async function decodeMono(file: string): Promise<Float32Array> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-t", "90", "-i", file, "-ac", "1", "-ar", String(BEAT_SAMPLE_RATE), "-f", "f32le", "pipe:1"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  // Copied: a Buffer may start at an offset a Float32Array cannot be aligned to.
  const bytes = Math.floor(stdout.byteLength / 4) * 4;
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + bytes));
}

/**
 * Thumbnail for a 360 photo: the view a 9:16 camera has looking straight
 * ahead, not the warped 2:1 strip.
 */
export async function panoThumbnail(source: string, destination: string): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-y", "-i", source, "-vf", "v360=e:flat:h_fov=59:v_fov=90:w=270:h=480", "-q:v", "5", destination]);
}
