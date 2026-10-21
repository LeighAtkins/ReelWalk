/**
 * ffmpeg as the harness's image codec (ADR 0053). The worker runs `ffmpeg` and
 * `ffprobe` from PATH (apps/worker/src/render.ts); the harness does the same,
 * and `FFMPEG` / `FFPROBE` point it at another binary on a machine without
 * them on PATH (Remotion's own ffmpeg lacks the test sources and libx264).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Rgb } from "./image";

const run = promisify(execFile);
const BIG = 512 * 1024 * 1024;

export const ffmpegBin = (): string => process.env.FFMPEG || "ffmpeg";
export const ffprobeBin = (): string => process.env.FFPROBE || "ffprobe";

export async function ffmpeg(args: string[]): Promise<void> {
  await run(ffmpegBin(), ["-v", "error", "-y", ...args], { maxBuffer: BIG });
}

/** Any picture ffmpeg reads (PNG, JPEG), decoded to RGB, optionally scaled. */
export async function readImage(file: string, size?: { width: number; height: number }): Promise<Rgb> {
  const scale = size ? ["-vf", `scale=${size.width}:${size.height}:flags=area`] : [];
  const { stdout: header } = await run(ffmpegBin(), ["-hide_banner", "-i", file], { maxBuffer: BIG }).catch((error: { stderr?: string }) => ({ stdout: error.stderr ?? "" }));
  const found = /, (\d{2,5})x(\d{2,5})/.exec(header);
  const width = size?.width ?? Number(found?.[1]), height = size?.height ?? Number(found?.[2]);
  if (!width || !height) throw new Error(`readImage: cannot tell the size of ${file}`);
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", file, ...scale, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: BIG });
  if (stdout.length !== width * height * 3) throw new Error(`readImage: ${file} decoded to ${stdout.length} bytes, expected ${width}×${height}×3`);
  return { width, height, data: new Uint8Array(stdout) };
}

/** Writes RGB as a PNG. */
export async function writePng(image: Rgb, file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(ffmpegBin(), ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${image.width}x${image.height}`, "-i", "-", "-frames:v", "1", file], (error) => (error ? reject(error) : resolve()));
    child.stdin?.end(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength));
  });
}

/**
 * Exact frames of a video by index, in one decode pass: `select` keeps the
 * decoded frames whose number is asked for (a constant-frame-rate export's
 * frame n is the composition's frame n), scaled to `size`.
 */
export async function extractFrames(video: string, frames: number[], size: { width: number; height: number }): Promise<Map<number, Rgb>> {
  const wanted = [...new Set(frames)].sort((a, b) => a - b);
  if (!wanted.length) return new Map();
  const select = wanted.map((n) => `eq(n\\,${n})`).join("+");
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", video, "-vf", `select='${select}',scale=${size.width}:${size.height}:flags=area`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: BIG });
  const bytes = size.width * size.height * 3;
  const out = new Map<number, Rgb>();
  wanted.forEach((frame, i) => {
    if ((i + 1) * bytes <= stdout.length) out.set(frame, { ...size, data: new Uint8Array(stdout.subarray(i * bytes, (i + 1) * bytes)) });
  });
  return out;
}

/** Frame count and rate of a video, from ffprobe. */
export async function probeVideo(video: string): Promise<{ frames: number; fps: number; width: number; height: number }> {
  const { stdout } = await run(ffprobeBin(), ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,r_frame_rate,nb_read_packets", "-of", "json", video]);
  const stream = JSON.parse(stdout).streams?.[0] ?? {};
  const [num, den] = String(stream.r_frame_rate ?? "30/1").split("/").map(Number);
  return { frames: Number(stream.nb_read_packets ?? 0), fps: num / (den || 1), width: Number(stream.width), height: Number(stream.height) };
}
