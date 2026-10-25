/**
 * The Last Mile brand kit's styles (ADR 0078) drawn at 1080 x 1920 through the real composition, the one the preview and
 * the export share: the title card "LAST MILE" in `lastmile-title`, a punchline, two captions (magenta and cyan edge) and a
 * label, applied with the `applyTextStyle` command exactly as an agent would, over the smoke reel's footage.
 *
 *   FFMPEG=… tsx scripts/brand-stills.ts ../../docs/adr/assets/0078-lastmile-styles.png
 *
 * Writes the one PNG. Needs ffmpeg and a Chrome the renderer can use, like render-smoke.ts.
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyCommand, LAST_MILE_KIT, parseTimeline, type Command } from "@reelwalk/core";
import { renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { makeMedia, serve } from "./smoke-fixture";

const FRAME = 24;
const SHOT_MS = 2000;

const TEXTS = [
  { id: "label", text: "DAY 3 · 06:42", y: 0.1, style: "lastmile-label" },
  { id: "title", text: "LAST MILE", y: 0.28, style: "lastmile-title" },
  { id: "punch", text: "NO SIGNAL.", y: 0.47, style: "lastmile-punchline" },
  { id: "caption", text: "He still hasn't called.", y: 0.64, style: "lastmile-caption" },
  { id: "caption-cyan", text: "Battery 12%. Route B is open.", y: 0.74, style: "lastmile-caption-cyan" },
];

async function main() {
  const out = path.resolve(process.argv[2] ?? "0078-lastmile-styles.png");
  await mkdir(path.dirname(out), { recursive: true });
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-brand-"));
  const server = await serve(media);
  try {
    await makeMedia(media);
    const assets: Record<string, ReelAsset> = { walk: { src: `${server.url}/walk.mp4`, kind: "VIDEO" } };
    let timeline = parseTimeline({
      version: 1,
      clips: [{ id: "c", assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: SHOT_MS }],
      // Plain white texts, as an agent adds them: the kit styles are applied by name below.
      texts: TEXTS.map(({ id, text, y }) => ({ id, text, x: 0.5, y, startMs: 0, endMs: SHOT_MS, animation: "none" })),
      music: null,
    });
    for (const { id, style } of TEXTS) {
      const command: Command = { type: "applyTextStyle", textId: id, style };
      const result = applyCommand(timeline, command, { generation: 0, brandKit: LAST_MILE_KIT });
      if (result.rejected) throw new Error(`${style}: ${result.rejected}`);
      timeline = result.timeline;
    }
    const pngs = path.join(media, "png");
    await mkdir(pngs, { recursive: true });
    const stills = await renderReelStills({ timeline, assets, frames: [FRAME], dir: pngs, width: 1080, timeoutMs: 90_000 });
    const png = stills.get(FRAME);
    if (!png) throw new Error("the composition drew no still");
    await copyFile(png, out);
    console.log(out);
  } finally {
    server.close();
    await rm(media, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
