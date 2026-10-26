/**
 * Before/after sheets for the Remotion-primitives change (ADR 0081).
 *
 *   FFMPEG=<ffmpeg with libx264 and tile> MEDIA=<dir with s1.mp4 … s6.mp4> pnpm --filter @reelwalk/render exec tsx scripts/primitives-compare.ts <outDir> [--export]
 *
 * Draws the frames of primitives-fixture.ts with the real renderer at 270×480, tiles each group (a cut, or the titles)
 * into one sheet `<group>.png`, and with `--export` encodes the whole reel and prints how long that took. Any portrait
 * clips will do for the media; the ADR's sheets used five Pexels snow-lodge clips (not committed).
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { renderReel, renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpegBin } from "./acceptance/ffmpeg";
import { framesToShow, MEDIA, primitivesTimeline } from "./primitives-fixture";
import { serve } from "./smoke-fixture";

const run = promisify(execFile);

async function main() {
  const args = process.argv.slice(2);
  const out = path.resolve(args.find((arg) => !arg.startsWith("-")) ?? "primitives-out");
  const media = process.env.MEDIA;
  if (!media) throw new Error("MEDIA=<dir with s1.mp4 … s6.mp4> is required");
  const stills = path.join(out, "stills");
  await mkdir(stills, { recursive: true });
  const server = await serve(media);
  try {
    const assets: Record<string, ReelAsset> = Object.fromEntries(MEDIA.map((file, i) => [`s${i + 1}`, { src: `${server.url}/${file}`, kind: "VIDEO" as const, durationMs: 4000 }]));
    const timeline = primitivesTimeline();
    const shots = framesToShow(timeline);
    const started = Date.now();
    const made = await renderReelStills({ timeline, assets, frames: shots.map((s) => s.frame), dir: stills, width: 270, timeoutMs: 120_000 });
    console.log(`stills: ${made.size} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const groups = new Map<string, string[]>();
    for (const shot of shots) {
      const file = made.get(shot.frame);
      if (!file) { console.log(`  frame ${shot.frame} (${shot.why}) not drawn`); continue; }
      groups.set(shot.group, [...(groups.get(shot.group) ?? []), file]);
    }
    for (const [group, files] of groups) {
      // Copied in order so ffmpeg's image2 pattern reads them as one sequence, then tiled into a single row.
      const tmp = path.join(out, `tmp-${group}`);
      await mkdir(tmp, { recursive: true });
      for (const [i, file] of files.entries()) await copyFile(file, path.join(tmp, `${String(i).padStart(3, "0")}.png`));
      await run(ffmpegBin(), ["-v", "error", "-y", "-i", path.join(tmp, "%03d.png"), "-vf", `tile=${files.length}x1:padding=4:color=white`, "-frames:v", "1", path.join(out, `${group}.png`)]);
      await rm(tmp, { recursive: true, force: true });
    }
    await writeFile(path.join(out, "frames.json"), JSON.stringify(shots, null, 2));
    if (args.includes("--export")) {
      const output = path.join(out, "reel.mp4");
      const t0 = Date.now();
      await renderReel({ timeline, assets, output, concurrency: 2 }, () => undefined);
      const seconds = (Date.now() - t0) / 1000;
      console.log(`export: ${seconds.toFixed(1)} s → ${output}`);
      await writeFile(path.join(out, "export-time.txt"), `${seconds.toFixed(1)} s for ${timeline.clips.length} shots (concurrency 2)\n`);
    }
    console.log(`sheets: ${[...groups.keys()].join(", ")} → ${out}`);
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
