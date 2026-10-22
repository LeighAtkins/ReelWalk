/**
 * The black-frame regression, at the renderer (ADR 0067): a cut 20–30 ms off
 * a frame boundary used to render one frame with no video (titles still
 * drawn) just before the cut, because the media was trimmed on its own
 * rounding of the clip's end and came up one frame short of the sequence.
 * The owner's cuts that showed it, 3025, 11333 and 22167 ms, are the cuts
 * here (black-frame-fixture.ts). Two of the shots also carry the new motion
 * (a speed ramp into the cut, an eased camera move), so the ramped media
 * window is tested at the cut as well.
 *
 *   FFMPEG=<ffmpeg> pnpm --filter @reelwalk/render exec tsx scripts/black-frame.ts [outDir] [--export] [--codec mpeg4]
 *
 * Draws, with the real renderer, the two frames before each cut and the two
 * after it, plus every clip's first and last frame, and fails if any frame's
 * mean luma is near black (the shots are bright test patterns, so a dark
 * frame can only be a missing picture). `--export` also encodes the whole
 * reel and scans every frame of the MP4 the way the owner's flashscan.sh
 * does. `--codec mpeg4` encodes the fixture as MPEG-4 Part 2, which
 * WebCodecs does not decode, so the composition's media falls back to
 * Remotion's OffthreadVideo: the path on which a window one frame short
 * draws nothing at all. Needs ffmpeg for the fixture media and a Chrome the
 * renderer can use.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { clipStartsMs } from "@reelwalk/core";
import { renderReel, renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpegBin, readImage } from "./acceptance/ffmpeg";
import { blackFrameTimeline, FPS, framesToCheck } from "./black-frame-fixture";
import { serve } from "./smoke-fixture";

const run = promisify(execFile);
/** A frame darker than this (mean luma, 0–255) has no picture; the patterns average well over 80. */
const DARK = 40;

async function meanLuma(file: string): Promise<number> {
  const image = await readImage(file, { width: 54, height: 96 });
  let sum = 0;
  for (let i = 0; i < image.data.length; i += 3) sum += 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
  return sum / (image.data.length / 3);
}

async function makeMedia(dir: string, codec: "h264" | "mpeg4") {
  // Three bright, moving test patterns, long enough for every window.
  const sources = { a: "testsrc2=size=1080x1920:rate=30", b: "smptehdbars=size=1080x1920:rate=30", c: "testsrc=size=1080x1920:rate=30" };
  const encode = codec === "mpeg4" ? ["-c:v", "mpeg4", "-q:v", "3"] : ["-c:v", "libx264", "-preset", "veryfast"];
  for (const [name, source] of Object.entries(sources)) {
    await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", source, "-t", "14", "-pix_fmt", "yuv420p", ...encode, path.join(dir, `${name}.mp4`)]);
  }
}

/** Every frame of an MP4 whose mean luma is near black after a bright one (the owner's flashscan.sh). */
async function flashScan(file: string): Promise<{ frame: number; luma: number }[]> {
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", file, "-vf", "scale=54:96,format=gray", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  const n = 54 * 96;
  const dark: { frame: number; luma: number }[] = [];
  let previous: number | null = null;
  for (let i = 0; i + n <= stdout.length; i += n) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += stdout[i + j];
    const luma = sum / n;
    if (previous !== null && luma < 12 && previous > 30) dark.push({ frame: i / n, luma });
    previous = luma;
  }
  return dark;
}

async function main() {
  const args = process.argv.slice(2);
  const exportToo = args.includes("--export");
  const codec = args[args.indexOf("--codec") + 1] === "mpeg4" ? "mpeg4" : "h264";
  const keepIn = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--codec");
  const dir = keepIn ? path.resolve(keepIn) : await mkdtemp(path.join(os.tmpdir(), "reelwalk-black-frame-"));
  await mkdir(dir, { recursive: true });
  const media = path.join(dir, "media");
  await mkdir(media, { recursive: true });
  const server = await serve(media);
  try {
    await makeMedia(media, codec);
    const assets: Record<string, ReelAsset> = { a: { src: `${server.url}/a.mp4`, kind: "VIDEO" }, b: { src: `${server.url}/b.mp4`, kind: "VIDEO" }, c: { src: `${server.url}/c.mp4`, kind: "VIDEO" } };
    const timeline = blackFrameTimeline();
    const starts = clipStartsMs(timeline);
    console.log(`black-frame: cuts at ${starts.slice(1).join(", ")} ms, media ${codec}${codec === "mpeg4" ? " (WebCodecs cannot decode it: OffthreadVideo fallback)" : ""}`);
    const points = framesToCheck(timeline);
    const stills = path.join(dir, "stills");
    await mkdir(stills, { recursive: true });
    const made = await renderReelStills({ timeline, assets, frames: points.map((p) => p.frame), dir: stills, width: 270, timeoutMs: 60_000 });
    const failures: string[] = [];
    for (const point of points) {
      const file = made.get(point.frame);
      if (!file) { failures.push(`frame ${point.frame} (${point.why}) was not drawn`); continue; }
      const luma = await meanLuma(file);
      const bad = luma < DARK;
      console.log(`  frame ${String(point.frame).padStart(4)}  ${point.why.padEnd(20)}  luma ${luma.toFixed(1)}${bad ? "  ← DARK" : ""}`);
      if (bad) failures.push(`frame ${point.frame} (${point.why}) is near black: luma ${luma.toFixed(1)}`);
    }
    if (exportToo) {
      const output = path.join(dir, "black-frame.mp4");
      await renderReel({ timeline, assets, output, concurrency: 2 }, () => undefined);
      const dark = await flashScan(output);
      console.log(`black-frame: export scanned, ${dark.length} flash frames${dark.length ? ` at ${dark.map((d) => `${d.frame} (${(d.frame / FPS).toFixed(3)} s)`).join(", ")}` : ""}`);
      for (const d of dark) failures.push(`exported frame ${d.frame} (${(d.frame / FPS).toFixed(3)} s) is near black: luma ${d.luma.toFixed(1)}`);
    }
    if (failures.length) throw new Error(`black-frame: ${failures.length} failure(s)\n  ${failures.join("\n  ")}`);
    console.log(`black-frame: ${points.length} frames checked, none dark${keepIn ? ` → ${dir}` : ""}`);
  } finally {
    server.close();
    if (!keepIn) await rm(dir, { recursive: true, force: true });
    else console.log(`kept: ${(await readdir(path.join(dir, "stills"))).length} stills in ${path.join(dir, "stills")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
