/**
 * Frame comparison for the acceptance harness (ADR 0053): exact frames of an
 * MP4 against reference PNGs (or against stills the composition drew), scored
 * with SSIM and the worst 16-px block, and a contact sheet for people to look at.
 *
 *   tsx scripts/compare-frames.ts <video.mp4> --refs <dir> [--frames 0,30,60] [--shots 0-74,75-146]
 *       [--min-ssim 0.9] [--max-block 32] [--sheet sheet.png] [--update]
 *
 * References are `frame-<n>.png` in `--refs`; `--update` writes them from the
 * video instead of comparing (the first baseline). Without `--frames`, the
 * frames are the first, ¼, ½, ¾ and last of every shot in `--shots` (or of
 * the whole video). Exits 1 when any frame is outside the tolerance or a
 * reference is missing. Needs ffmpeg and ffprobe (or FFMPEG / FFPROBE).
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareImages, contactSheet, withinTolerance, type FrameScore, type Rgb, type Tolerance } from "./acceptance/image";
import { extractFrames, probeVideo, readImage, writePng } from "./acceptance/ffmpeg";

/** Frames are compared at a quarter of 1080×1920: enough for a title's edges, small enough to be quick and to forgive the encoder. */
export const COMPARE_SIZE = { width: 270, height: 480 };

export type FrameResult = { frame: number; score: FrameScore | null; ok: boolean; note?: string };

/** First, quarter, half, three quarters and last frame of a shot running [from, to). */
export function fiveOf(from: number, to: number): number[] {
  const last = Math.max(from, to - 1);
  return [...new Set([0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(from + p * (last - from))))];
}

export function formatResult(result: FrameResult, label = "frame"): string {
  if (!result.score) return `  ${label} ${String(result.frame).padStart(4)}  ${result.ok ? "ok  " : "FAIL"}  ${result.note ?? ""}`;
  const { ssim, worstBlock, worstAt } = result.score;
  return `  ${label} ${String(result.frame).padStart(4)}  ${result.ok ? "ok  " : "FAIL"}  ssim ${ssim.toFixed(4)}  worst block ${worstBlock.toFixed(1)} at ${worstAt.x},${worstAt.y}${result.note ? `  ${result.note}` : ""}`;
}

/** Each frame of `frames` against the picture `reference(frame)` gives (null: no reference). */
export async function compareFrames(video: string, frames: number[], reference: (frame: number) => Promise<Rgb | null>, tolerance: Tolerance): Promise<{ results: FrameResult[]; decoded: Map<number, Rgb> }> {
  const decoded = await extractFrames(video, frames, COMPARE_SIZE);
  const results: FrameResult[] = [];
  for (const frame of frames) {
    const actual = decoded.get(frame);
    if (!actual) { results.push({ frame, score: null, ok: false, note: "the video has no such frame" }); continue; }
    const expected = await reference(frame);
    if (!expected) { results.push({ frame, score: null, ok: false, note: "no reference" }); continue; }
    const score = compareImages(actual, expected, COMPARE_SIZE);
    results.push({ frame, score, ok: withinTolerance(score, tolerance) });
  }
  return { results, decoded };
}

/** References in a directory, `frame-<n>.png`, read at the comparison size. */
export function referencesIn(dir: string): (frame: number) => Promise<Rgb | null> {
  return async (frame) => {
    const file = path.join(dir, `frame-${frame}.png`);
    return existsSync(file) ? readImage(file, COMPARE_SIZE) : null;
  };
}

/** Writes the given frames as references. */
export async function writeReferences(frames: Map<number, Rgb>, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [frame, image] of frames) await writePng(image, path.join(dir, `frame-${frame}.png`));
}

/** A contact sheet of the frames, one row per shot. */
export async function writeSheet(rows: number[][], frames: Map<number, Rgb>, file: string): Promise<void> {
  const images = rows.map((row) => row.map((frame) => frames.get(frame)).filter((image): image is Rgb => Boolean(image)));
  await mkdir(path.dirname(file), { recursive: true });
  await writePng(contactSheet(images), file);
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(arg.slice(2), next); i++; } else flags.set(arg.slice(2), true);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const video = positional[0];
  const refs = typeof flags.get("refs") === "string" ? path.resolve(String(flags.get("refs"))) : undefined;
  if (!video || !refs) {
    console.error("usage: compare-frames <video.mp4> --refs <dir> [--frames 0,30] [--shots 0-74,75-146] [--min-ssim 0.9] [--max-block 32] [--sheet out.png] [--update]");
    process.exit(2);
  }
  const info = await probeVideo(video);
  const shots = typeof flags.get("shots") === "string"
    ? String(flags.get("shots")).split(",").map((range) => range.split("-").map(Number)).map(([a, b]) => [a, b + 1] as [number, number])
    : [[0, info.frames] as [number, number]];
  const rows = shots.map(([a, b]) => fiveOf(a, b));
  const frames = typeof flags.get("frames") === "string" ? String(flags.get("frames")).split(",").map(Number) : rows.flat();
  const tolerance: Tolerance = { minSsim: Number(flags.get("min-ssim") ?? 0.9), maxBlock: Number(flags.get("max-block") ?? 32) };

  if (flags.get("update")) {
    const decoded = await extractFrames(video, frames, COMPARE_SIZE);
    await writeReferences(decoded, refs);
    console.log(`compare-frames: wrote ${decoded.size} references to ${refs}`);
    if (typeof flags.get("sheet") === "string") await writeSheet(rows, decoded, path.resolve(String(flags.get("sheet"))));
    return;
  }
  const { results, decoded } = await compareFrames(video, frames, referencesIn(refs), tolerance);
  console.log(`compare-frames: ${video} against ${refs} (ssim ≥ ${tolerance.minSsim}, worst block ≤ ${tolerance.maxBlock})`);
  for (const result of results) console.log(formatResult(result));
  if (typeof flags.get("sheet") === "string") {
    const sheet = path.resolve(String(flags.get("sheet")));
    await writeSheet(rows, decoded, sheet);
    console.log(`compare-frames: contact sheet → ${sheet}`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    console.error(`compare-frames: ${failed.length} of ${results.length} frames outside the tolerance`);
    process.exit(1);
  }
  console.log(`compare-frames: ok, ${results.length} frames`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("compare-frames: FAILED:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
