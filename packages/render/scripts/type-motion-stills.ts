/**
 * Stills of every motion-graphics preset (ADR 0061) at full size, on the smoke
 * reel's real footage (the reader by the fire): Sweep, Glint and Golden hour on
 * the window she sits under, word by word, from behind a post, a count-up,
 * and a pinned callout with its track lost at the end. Drawn with
 * `renderReelStills`, the composition the preview and the export share.
 *
 *   FFMPEG=… tsx scripts/type-motion-stills.ts ./out
 *
 * Writes out/<preset>-<frame>.jpg (1080 × 1920). Needs ffmpeg and a Chrome the
 * renderer can use, like render-smoke.ts.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { calloutQuad, parseTimeline, type Timeline } from "@reelwalk/core";
import { renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpeg } from "./acceptance/ffmpeg";
import { makeMedia, serve } from "./smoke-fixture";

/** The window over the reader's head (smoke-fixture.ts), and where a slow drift takes it. */
const window = [0.4, 0.05, 0.93, 0.05, 0.93, 0.2, 0.4, 0.2];
const windowMoved = [0.38, 0.06, 0.91, 0.06, 0.91, 0.21, 0.38, 0.21];
const SHOT_MS = 2000;

type Case = { name: string; title: Record<string, unknown>; frames: number[] };

/** One two-second shot of the reader per case, a title on each. `frames` are frames into the shot. */
const CASES: Case[] = [
  { name: "sweep", frames: [20, 26, 32], title: { text: "BY THE FIRE", style: "headline", size: 1, animation: "none", blend: "surface", surface: window, shine: { preset: "sweep" } } },
  { name: "glint", frames: [18, 30, 45], title: { text: "BY THE FIRE", style: "headline", size: 1, animation: "none", blend: "surface", surface: window, shine: { preset: "glint" } } },
  { name: "golden", frames: [24, 33, 42], title: { text: "BY THE FIRE", style: "headline", size: 1, animation: "none", blend: "surface", surface: window, shine: { preset: "golden" } } },
  { name: "words", frames: [6, 14, 30], title: { text: "Four beds by the sea", x: 0.5, y: 0.42, style: "elegant", size: 1.2, kinetic: { preset: "words" } } },
  // The window's right pane, with the middle mullion beside it marked as a post: the words slide out from behind the mullion.
  { name: "behind", frames: [4, 9, 30], title: { text: "SNOW", style: "headline", size: 1, animation: "none", blend: "surface", surface: [0.645, 0.05, 0.92, 0.05, 0.92, 0.2, 0.645, 0.2], bars: [[0.6, 0.05, 0.64, 0.05, 0.64, 0.2, 0.6, 0.2]], kinetic: { preset: "behind" } } },
  { name: "count", frames: [10, 22, 45], title: { text: "$1,250,000", x: 0.5, y: 0.42, style: "headline", size: 1.2, kinetic: { preset: "count" }, shine: { preset: "sweep", startMs: 1300 } } },
];

function timeline(): Timeline {
  const point = { x: 0.62, y: 0.83 };
  const square = calloutQuad(point);
  const squareMoved = square.map((v, i) => Number((v + (i % 2 === 0 ? -0.02 : 0.01)).toFixed(4)));
  const texts = CASES.map((c, i) => ({
    id: c.name, startMs: i * SHOT_MS, endMs: (i + 1) * SHOT_MS, x: 0.66, y: 0.12, ...c.title,
    ...(c.title.surface === window ? { pin: { assetId: "walk", fromMs: 0, toMs: SHOT_MS, quad: window }, path: [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: window }, { t: 1, x: -0.02, y: 0.01, s: 1, r: 0, q: windowMoved }] } : {}),
  }));
  // A callout on the woodpile, pinned (a synthetic track: it drifts with the camera, then is lost for the last half second).
  const at = CASES.length * SHOT_MS;
  texts.push({
    id: "callout", text: "Seasoned oak", startMs: at, endMs: at + SHOT_MS, x: 0.4, y: 0.7, style: "box", size: 0.6, animation: "auto", callout: point,
    pin: { assetId: "walk", fromMs: 0, toMs: SHOT_MS, quad: square },
    path: [{ t: 0, x: 0, y: 0, q: square }, { t: 0.7, x: -0.02, y: 0.01, q: squareMoved }, { t: 0.78, x: -0.02, y: 0.01, q: squareMoved, o: 0 }, { t: 1, x: -0.02, y: 0.01, q: squareMoved, o: 0 }],
  } as never);
  return parseTimeline({
    version: 1,
    clips: [...CASES, { name: "callout" }].map((c) => ({ id: `c-${c.name}`, assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: SHOT_MS })),
    texts, music: null,
  });
}

async function main() {
  const out = path.resolve(process.argv[2] ?? "type-motion-stills");
  await mkdir(out, { recursive: true });
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-motion-"));
  const server = await serve(media);
  try {
    await makeMedia(media);
    const assets: Record<string, ReelAsset> = { walk: { src: `${server.url}/walk.mp4`, kind: "VIDEO" } };
    const shotFrames = (SHOT_MS * 30) / 1000;
    const wanted = [...CASES, { name: "callout", frames: [3, 9, 15, 40, 57] }].flatMap((c, i) => c.frames.map((f) => ({ name: c.name, frame: i * shotFrames + f, local: f })));
    const pngs = path.join(media, "png");
    await mkdir(pngs, { recursive: true });
    const stills = await renderReelStills({ timeline: timeline(), assets, frames: wanted.map((w) => w.frame), dir: pngs, width: 1080, timeoutMs: 60_000 });
    for (const w of wanted) {
      const png = stills.get(w.frame);
      if (!png) continue;
      const jpg = path.join(out, `${w.name}-${String(w.local).padStart(2, "0")}.jpg`);
      await ffmpeg(["-v", "error", "-y", "-i", png, "-q:v", "3", jpg]);
      console.log(jpg);
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
