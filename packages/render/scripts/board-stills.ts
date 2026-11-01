/**
 * Stills of a board (ADR 0106) laid out as the owner's reference reel 5019: a 4×4 board from 1.8 s, the opening
 * shot shrinking into the first panel, columns sliding in at 3.45, 5.3 and 7.3 s with every panel's keyword arriving
 * with its effect, and the social outro from 9.73 s. Drawn with `renderReelStills` (the composition the preview and
 * the export share) on the smoke fixture's footage, then one contact sheet.
 *
 *   tsx scripts/board-stills.ts ./out
 *
 * Writes out/board-<ms>.jpg and out/sheet-board.jpg. Needs ffmpeg and a Chrome the renderer can use.
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

const KEYWORDS: Record<NamedEffect, string> = {
  dotHop: "dot hop", rollout: "rollout", slingshot: "slingshot", splits: "splits",
  timelineScrub: "timeline", tracedOutline: "traced", orbitRing: "orbit", pluckedString: "plucked",
  stickerStack: "drop.", oneBigSlam: "slam.", tumblingLetters: "tumble", heavyLanding: "heavy",
  pixelSwarm: "pixels", pixelRain: "rain", mosaicResolve: "resolve", ledScoreboard: "score",
};
/** Reel times to draw: the hook, the entry, each column settling, mid-slide, the outro. */
const TIMES = [600, 1850, 1950, 2100, 2700, 3200, 3560, 4300, 5900, 8200, 9900, 11000];

function timeline(): Timeline {
  const effects = Object.values(EFFECT_FAMILIES).flat() as NamedEffect[];
  return parseTimeline({
    version: 1,
    clips: [0, 1, 2, 3].map((i) => ({ id: `c${i}`, assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3440 })),
    texts: [
      { id: "hook-a", text: "really good", startMs: 0, endMs: 1730, x: 0.38, y: 0.19, style: "plain", size: 1.1, color: "#FFFFFF", animation: "type" },
    ],
    music: null,
    board: {
      startMs: 1800,
      endMs: 13760,
      rows: 4,
      columns: 4,
      columnAtMs: [3450, 5300, 7300],
      panels: effects.map((effect, i) => ({
        id: effect,
        label: TEXT_ANIMATION_LABELS[effect],
        assetId: "walk",
        sourceStartMs: (i % 4) * 300,
        mirror: i >= 4,
        title: { lead: "try this", keyword: KEYWORDS[effect], effect, side: i < 4 ? "left" : "right", delayMs: (i % 4) * 80 },
      })),
      outro: { atMs: 9730, handle: "@reelwalking" },
    },
  });
}

async function main() {
  const out = path.resolve(process.argv[2] ?? "board-stills");
  await mkdir(out, { recursive: true });
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-board-"));
  const server = await serve(media);
  try {
    await makeMedia(media);
    const assets: Record<string, ReelAsset> = { walk: { src: `${server.url}/walk.mp4`, kind: "VIDEO", durationMs: 3966 } };
    const frames = TIMES.map((ms) => Math.round((ms * 30) / 1000));
    const pngs = path.join(media, "png");
    await mkdir(pngs, { recursive: true });
    const stills = await renderReelStills({ timeline: timeline(), assets, frames, dir: pngs, width: 1080, timeoutMs: 180_000 });
    const jpgs: string[] = [];
    for (const [i, frame] of frames.entries()) {
      const png = stills.get(frame);
      if (!png) continue;
      const jpg = path.join(out, `board-${String(TIMES[i]).padStart(5, "0")}.jpg`);
      await ffmpeg(["-v", "error", "-y", "-i", png, "-vf", "scale=270:-2", "-q:v", "3", jpg]);
      jpgs.push(jpg);
    }
    await ffmpeg(["-v", "error", "-y", ...jpgs.flatMap((jpg) => ["-i", jpg]), "-filter_complex", `${jpgs.map((_, k) => `[${k}:v]`).join("")}xstack=inputs=${jpgs.length}:layout=${jpgs.map((_, k) => `${(k % 6) * 270}_${Math.floor(k / 6) * 480}`).join("|")}`, "-q:v", "3", path.join(out, "sheet-board.jpg")]);
    console.log(path.join(out, "sheet-board.jpg"));
  } finally {
    server.close();
    await rm(media, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
