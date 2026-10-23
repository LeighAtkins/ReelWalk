/**
 * The speed-ramp transition at the renderer (ADR 0073): draws, with the real
 * Remotion composition, every frame across a speed-ramp cut, checks none is
 * near black, assembles the frames into a strip, and with `--export` encodes
 * the reel (and the same reel with plain cuts, for the time), scans the MP4
 * for flash and frozen frames and reports how much longer the ramped export
 * took.
 *
 *   FFMPEG=<ffmpeg> pnpm --filter @reelwalk/render exec tsx scripts/speed-ramp.ts [outDir] [--export] [--strip path.png] [--cut 0|1]
 *
 * The test media is ffmpeg's testsrc2, whose burned-in frame counter shows
 * which source frame each reel frame draws: the strip reads as a proof of the
 * source-time mapping as well as of the blur and the push. Needs ffmpeg
 * (libx264) for the media and a Chrome the renderer can use.
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
import { serve } from "./smoke-fixture";
import { ASSET_DURATIONS, fixturePlan, speedRampTimeline, stripFrames } from "./speed-ramp-fixture";

const run = promisify(execFile);
const DARK = 40;

async function meanLuma(file: string): Promise<number> {
  const image = await readImage(file, { width: 54, height: 96 });
  let sum = 0;
  for (let i = 0; i < image.data.length; i += 3) sum += 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
  return sum / (image.data.length / 3);
}

async function makeMedia(dir: string) {
  const sources = { a: "testsrc2=size=1080x1920:rate=30", b: "testsrc2=size=1080x1920:rate=30,hue=h=120", c: "testsrc=size=1080x1920:rate=30" };
  for (const [name, source] of Object.entries(sources)) {
    await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", source.split(",")[0], ...(source.includes(",") ? ["-vf", source.split(",").slice(1).join(",")] : []), "-t", String(ASSET_DURATIONS[name] / 1000), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-g", "15", path.join(dir, `${name}.mp4`)]);
  }
}

/** Mean luma of every frame, and the difference to the frame before, from an MP4 (flash and frozen scan). */
async function scan(file: string): Promise<{ flash: number[]; frozen: number[]; frames: number; longestRun: number }> {
  const w = 108, h = 192, n = w * h;
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", file, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
  const flash: number[] = [], frozen: number[] = [];
  let previous: Buffer | null = null, previousLuma: number | null = null, frames = 0;
  for (let i = 0; i + n <= stdout.length; i += n, frames++) {
    const frame = stdout.subarray(i, i + n);
    let sum = 0, diff = 0;
    for (let j = 0; j < n; j++) { sum += frame[j]; if (previous) diff += Math.abs(frame[j] - previous[j]); }
    const luma = sum / n;
    if (previousLuma !== null && luma < 12 && previousLuma > 30) flash.push(frames);
    if (previous && diff / n < 0.05) frozen.push(frames);
    previous = frame;
    previousLuma = luma;
  }
  // A repeated frame where the body plays under 1× is a slow-down at 30 fps (the same sample-and-hold as any slow motion);
  // a stall is three or more in a row.
  let longestRun = 0, run_ = 0;
  frozen.forEach((frame, i) => { run_ = i > 0 && frame === frozen[i - 1] + 1 ? run_ + 1 : 1; longestRun = Math.max(longestRun, run_); });
  return { flash, frozen, frames, longestRun };
}

async function main() {
  const args = process.argv.slice(2);
  const exportToo = args.includes("--export");
  const stripOut = args.includes("--strip") ? path.resolve(args[args.indexOf("--strip") + 1]) : null;
  const cutIndex = args.includes("--cut") ? Number(args[args.indexOf("--cut") + 1]) : 0;
  const keepIn = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--strip" && args[i - 1] !== "--cut");
  const dir = keepIn ? path.resolve(keepIn) : await mkdtemp(path.join(os.tmpdir(), "reelwalk-speed-ramp-"));
  await mkdir(dir, { recursive: true });
  const media = path.join(dir, "media");
  await mkdir(media, { recursive: true });
  const server = await serve(media);
  try {
    await makeMedia(media);
    const assets: Record<string, ReelAsset> = Object.fromEntries(Object.keys(ASSET_DURATIONS).map((id) => [id, { src: `${server.url}/${id}.mp4`, kind: "VIDEO" as const, durationMs: ASSET_DURATIONS[id] }]));
    const timeline = speedRampTimeline();
    console.log(`speed-ramp: cuts at ${clipStartsMs(timeline).slice(1).join(", ")} ms`);
    for (const cut of fixturePlan(timeline).cuts) console.log(`  ${cut.note}`);

    const frames = stripFrames(timeline, cutIndex);
    const stills = path.join(dir, "stills");
    await mkdir(stills, { recursive: true });
    const made = await renderReelStills({ timeline, assets, frames, dir: stills, width: 270, timeoutMs: 90_000 });
    const failures: string[] = [];
    for (const frame of frames) {
      const file = made.get(frame);
      if (!file) { failures.push(`frame ${frame} was not drawn`); continue; }
      const luma = await meanLuma(file);
      console.log(`  frame ${String(frame).padStart(4)}  luma ${luma.toFixed(1)}${luma < DARK ? "  ← DARK" : ""}`);
      if (luma < DARK) failures.push(`frame ${frame} is near black: luma ${luma.toFixed(1)}`);
    }
    if (stripOut) {
      // One image: every frame across the cut, in order, left to right, top to bottom.
      const list = path.join(dir, "strip.txt");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(list, frames.map((f) => `file '${path.join(stills, `frame-${f}.png`).replace(/\\/g, "/")}'`).join("\n"));
      const columns = 10;
      await run(ffmpegBin(), ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `tile=${columns}x${Math.ceil(frames.length / columns)}:padding=4:color=black`, "-frames:v", "1", stripOut]);
      console.log(`speed-ramp: strip of ${frames.length} frames → ${stripOut}`);
    }
    if (exportToo) {
      const timed = async (label: string, t: ReturnType<typeof speedRampTimeline>) => {
        const output = path.join(dir, `${label}.mp4`);
        const started = Date.now();
        await renderReel({ timeline: t, assets, output, concurrency: 2 }, () => undefined);
        const seconds = (Date.now() - started) / 1000;
        const result = await scan(output);
        console.log(`speed-ramp: ${label} export ${seconds.toFixed(1)} s, ${result.frames} frames, ${result.flash.length} flash, ${result.frozen.length} repeated frames (longest run ${result.longestRun})${result.frozen.length ? ` at ${result.frozen.slice(0, 12).join(", ")}` : ""}`);
        return { seconds, result };
      };
      const plain = await timed("plain", speedRampTimeline(false));
      const ramped = await timed("ramped", timeline);
      console.log(`speed-ramp: ramped export took ${(ramped.seconds / plain.seconds).toFixed(2)}× the plain one`);
      for (const f of ramped.result.flash) failures.push(`exported frame ${f} is near black`);
      if (ramped.result.longestRun >= 3) failures.push(`exported frames repeat for ${ramped.result.longestRun} in a row: the picture stalled`);
    }
    if (failures.length) throw new Error(`speed-ramp: ${failures.length} failure(s)\n  ${failures.join("\n  ")}`);
    console.log(`speed-ramp: ${frames.length} frames checked, none dark${keepIn ? ` → ${dir}` : ""}`);
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
