import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A small actual video frame for library cards and timeline filmstrips. */
export async function aiThumbnail(video: Buffer): Promise<Buffer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reelwalk-ai-thumb-"));
  try {
    const input = path.join(directory, "input.mp4");
    await writeFile(input, video);
    const { stdout } = await run("ffmpeg", [
      "-v", "error", "-nostdin", "-threads", "2", "-ss", "0.5", "-i", input,
      "-frames:v", "1", "-an", "-vf", "scale=-2:240", "-pix_fmt", "yuvj420p",
      "-threads", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "pipe:1",
    ], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024, timeout: 30_000, windowsHide: true });
    if (stdout.length < 100 || stdout[0] !== 0xff || stdout[1] !== 0xd8) throw new Error("AI thumbnail could not be decoded.");
    return stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A take's real length in ms (an Omni take's length is asked for in words, so it is measured, ADR 0105); null when unreadable. */
export async function videoDurationMs(video: Buffer): Promise<number | null> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reelwalk-ai-probe-"));
  try {
    const input = path.join(directory, "input.mp4");
    await writeFile(input, video);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input], { timeout: 30_000, windowsHide: true });
    const seconds = Number(String(stdout).trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
