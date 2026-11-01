/**
 * Stills of the sixteen title effects (ADR 0103) on the smoke reel's real footage, one two-second shot each, at five
 * moments of the entrance and one at rest, drawn with `renderReelStills` (the composition the preview and the export
 * share), then one contact sheet per family.
 *
 *   FFMPEG=… tsx scripts/title-effect-stills.ts ./out
 *
 * Writes out/<effect>-<frame>.jpg and out/sheet-<family>.jpg. Needs ffmpeg and a Chrome the renderer can use.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EFFECT_FAMILIES, parseTimeline, type NamedEffect, type Timeline } from "@reelwalk/core";
import { renderReelStills } from "../src/render-reel";
import { TEXT_ANIMATION_LABELS } from "../src/reel/look";
import type { ReelAsset } from "../src/reel/types";
import { ffmpeg } from "./acceptance/ffmpeg";
import { makeMedia, serve } from "./smoke-fixture";

const SHOT_MS = 2000;
/** Frames into each shot: through the entrance, then at rest. */
const FRAMES = [2, 6, 10, 15, 21, 45];
const EFFECTS = Object.values(EFFECT_FAMILIES).flat() as NamedEffect[];

function timeline(): Timeline {
  return parseTimeline({
    version: 1,
    clips: EFFECTS.map((effect) => ({ id: `c-${effect}`, assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: SHOT_MS })),
    texts: EFFECTS.map((effect, i) => ({
      id: effect, text: TEXT_ANIMATION_LABELS[effect].toLowerCase(), startMs: i * SHOT_MS, endMs: (i + 1) * SHOT_MS,
      x: 0.5, y: 0.4, style: "headline", size: 1.15, color: "#F5D547", animation: effect,
    })),
    music: null,
  });
}

async function main() {
  const out = path.resolve(process.argv[2] ?? "title-effect-stills");
  await mkdir(out, { recursive: true });
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-effects-"));
  const server = await serve(media);
  try {
    await makeMedia(media);
    const assets: Record<string, ReelAsset> = { walk: { src: `${server.url}/walk.mp4`, kind: "VIDEO" } };
    const shotFrames = (SHOT_MS * 30) / 1000;
    const wanted = EFFECTS.flatMap((effect, i) => FRAMES.map((f) => ({ effect, frame: i * shotFrames + f, local: f })));
    const pngs = path.join(media, "png");
    await mkdir(pngs, { recursive: true });
    const stills = await renderReelStills({ timeline: timeline(), assets, frames: wanted.map((w) => w.frame), dir: pngs, width: 1080, timeoutMs: 120_000 });
    for (const w of wanted) {
      const png = stills.get(w.frame);
      if (!png) continue;
      const jpg = path.join(out, `${w.effect}-${String(w.local).padStart(2, "0")}.jpg`);
      await ffmpeg(["-v", "error", "-y", "-i", png, "-vf", "crop=1080:620:0:420,scale=360:-2", "-q:v", "3", jpg]);
    }
    // One sheet per family: a row per effect, its moments left to right.
    for (const [family, members] of Object.entries(EFFECT_FAMILIES)) {
      const inputs = members.flatMap((effect) => FRAMES.map((f) => ["-i", path.join(out, `${effect}-${String(f).padStart(2, "0")}.jpg`)])).flat();
      const n = members.length * FRAMES.length;
      await ffmpeg(["-v", "error", "-y", ...inputs, "-filter_complex", `${Array.from({ length: n }, (_, k) => `[${k}:v]`).join("")}xstack=inputs=${n}:layout=${Array.from({ length: n }, (_, k) => `${(k % FRAMES.length) * 360}_${Math.floor(k / FRAMES.length) * 206}`).join("|")}`, "-q:v", "3", path.join(out, `sheet-${family}.jpg`)]);
      console.log(path.join(out, `sheet-${family}.jpg`));
    }
  } finally {
    server.close();
    await rm(media, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
