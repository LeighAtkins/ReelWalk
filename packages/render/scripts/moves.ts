/**
 * The camera-move library at the renderer (ADR 0076): draws, with the real Remotion composition, ten frames of each of three
 * deterministic moves (crash zoom, parallax slide, push through a doorway) written onto test footage by `applyMove`, checks none
 * is near black, and assembles them into one strip, a row per move.
 *
 *   FFMPEG=<ffmpeg> pnpm --filter @reelwalk/render exec tsx scripts/moves.ts [outDir] [--strip path.png]
 *
 * The test media is ffmpeg's testsrc2, whose grid and burned-in counter make a scale or a shift easy to read. Needs ffmpeg
 * (libx264) for the media and a Chrome the renderer can use.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { clipStartsMs } from "@reelwalk/core";
import { renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpegBin, readImage } from "./acceptance/ffmpeg";
import { serve } from "./smoke-fixture";
import { ASSET_DURATIONS, MOVE_ROWS, movesTimeline, rowFrames } from "./moves-fixture";

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

async function main() {
  const args = process.argv.slice(2);
  const stripOut = args.includes("--strip") ? path.resolve(args[args.indexOf("--strip") + 1]) : null;
  const keepIn = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--strip");
  const dir = keepIn ? path.resolve(keepIn) : await mkdtemp(path.join(os.tmpdir(), "reelwalk-moves-"));
  await mkdir(dir, { recursive: true });
  const media = path.join(dir, "media");
  await mkdir(media, { recursive: true });
  const server = await serve(media);
  try {
    await makeMedia(media);
    const assets: Record<string, ReelAsset> = Object.fromEntries(Object.keys(ASSET_DURATIONS).map((id) => [id, { src: `${server.url}/${id}.mp4`, kind: "VIDEO" as const, durationMs: ASSET_DURATIONS[id] }]));
    const timeline = movesTimeline();
    console.log(`moves: cuts at ${clipStartsMs(timeline).slice(1).join(", ")} ms`);
    const rows = MOVE_ROWS.map((row) => ({ ...row, frames: rowFrames(timeline, row.clipId) }));
    const all = rows.flatMap((row) => row.frames);
    const stills = path.join(dir, "stills");
    await mkdir(stills, { recursive: true });
    const made = await renderReelStills({ timeline, assets, frames: all, dir: stills, width: 270, timeoutMs: 90_000 });
    const failures: string[] = [];
    for (const row of rows) {
      console.log(`  ${row.label}: frames ${row.frames.join(", ")}`);
      for (const frame of row.frames) {
        const file = made.get(frame);
        if (!file) { failures.push(`frame ${frame} (${row.label}) was not drawn`); continue; }
        const luma = await meanLuma(file);
        if (luma < DARK) failures.push(`frame ${frame} (${row.label}) is near black: luma ${luma.toFixed(1)}`);
      }
    }
    if (failures.length) throw new Error(`moves: ${failures.length} failure(s)\n  ${failures.join("\n  ")}`);
    if (stripOut) {
      // One image: a row of ten frames per move, in the order of the table above.
      const list = path.join(dir, "strip.txt");
      await writeFile(list, all.map((f) => `file '${path.join(stills, `frame-${f}.png`).replaceAll(path.sep, "/")}'`).join("\n"));
      await run(ffmpegBin(), ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `tile=10x${rows.length}:padding=4:color=black`, "-frames:v", "1", stripOut]);
      console.log(`moves: ${rows.length} rows of ten frames → ${stripOut}`);
    }
    console.log(`moves: ${all.length} frames drawn, none dark`);
  } finally {
    server.close();
    if (!keepIn) await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
