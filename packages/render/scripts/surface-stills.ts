/**
 * A title put on a surface (ADR 0075), drawn by the real composition: stills at the start, middle and end of
 * the shot from the placement files `apps/web/scripts/surface-verify.mts --placements` writes. The title is
 * written into the timeline with `surfacePatch`, exactly what the editor and the command write, so this shows
 * the house serif, the ink, the surface blend and the tracked corners as the export would draw them.
 *
 *   FFMPEG=… tsx scripts/surface-stills.ts out.jpg placement.json [placement.json ...]
 *
 * One row of three frames per placement, side by side. Needs ffmpeg and a Chrome the renderer can use, like render-smoke.ts.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTimeline, surfacePatch, type TitleOnSurface } from "@reelwalk/core";
import { renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpeg } from "./acceptance/ffmpeg";
import { serve } from "./smoke-fixture";

type Saved = { file: string; startMs: number; lengthMs: number; text: string; placement: TitleOnSurface };

async function main() {
  const [outFile, ...inputs] = process.argv.slice(2);
  if (!outFile || inputs.length === 0) throw new Error("usage: surface-stills.ts out.jpg placement.json ...");
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-surface-"));
  const server = await serve(media);
  const rows: string[] = [];
  try {
    for (const [index, input] of inputs.entries()) {
      const saved = JSON.parse(await readFile(input, "utf8")) as Saved;
      const name = `shot${index}.mp4`;
      // The shot is read from the source at the source times the pin was tracked on (pin.fromMs/toMs), so the file is served whole.
      await copyFile(saved.file, path.join(media, name));
      const assetId = saved.placement.pinned?.pin.assetId ?? "a";
      const frames = Math.round((saved.lengthMs * 30) / 1000);
      const timeline = parseTimeline({
        version: 1,
        clips: [{ id: "c", assetId, kind: "VIDEO", sourceStartMs: saved.startMs, sourceEndMs: saved.startMs + saved.lengthMs }],
        texts: [{ id: "t", text: saved.text, startMs: 0, endMs: saved.lengthMs, ...surfacePatch(saved.placement), animation: "none" }],
        music: null,
      });
      const assets: Record<string, ReelAsset> = { [assetId]: { src: `${server.url}/${name}`, kind: "VIDEO" } };
      const wanted = [2, Math.round(frames / 2), frames - 3];
      const dir = path.join(media, `png${index}`);
      await mkdir(dir, { recursive: true });
      const stills = await renderReelStills({ timeline, assets, frames: wanted, dir, width: 540, timeoutMs: 90_000 });
      const pngs = wanted.map((f) => stills.get(f)).filter((p): p is string => Boolean(p));
      const row = path.join(media, `row${index}.png`);
      await ffmpeg(["-v", "error", "-y", ...pngs.flatMap((p) => ["-i", p]), "-filter_complex", `hstack=inputs=${pngs.length}`, row]);
      rows.push(row);
    }
    await ffmpeg(["-v", "error", "-y", ...rows.flatMap((p) => ["-i", p]), "-filter_complex", rows.length > 1 ? `hstack=inputs=${rows.length}` : "null", "-q:v", "4", path.resolve(outFile)]);
    console.log(path.resolve(outFile));
  } finally {
    server.close();
    await rm(media, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
