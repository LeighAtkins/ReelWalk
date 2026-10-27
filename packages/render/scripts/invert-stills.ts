/**
 * Proof stills of inverted titles (ADR 0091), drawn with `renderReelStills`, the composition the preview and the export
 * share. The picture is a still with a dark wall on the left, a bright window on the right and a dark mullion across the
 * window, so one word sits over both; the titles are "dollar" in white (a true negative) and in the reference's pale
 * yellow (a tinted negative), and a plain white title for comparison.
 *
 *   tsx scripts/invert-stills.ts <picture.png> ./out
 *
 * Writes one 1080 × 1920 PNG per case into out and prints its path.
 * Needs a Chrome the renderer can use, like render-smoke.ts.
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTimeline, type Timeline } from "@reelwalk/core";
import { renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { serve } from "./smoke-fixture";

const SHOT_MS = 1000;
const CASES = [
  { name: "invert-white", title: { color: "#ffffff", blend: "invert" } },
  { name: "invert-yellow", title: { color: "#f2ef9c", blend: "invert" } },
  { name: "plain-white", title: { color: "#ffffff" } },
] as const;

function timeline(): Timeline {
  return parseTimeline({
    version: 1,
    clips: CASES.map((c) => ({ id: `c-${c.name}`, assetId: "wall", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: SHOT_MS })),
    texts: CASES.map((c, i) => ({ id: c.name, text: "dollar", startMs: i * SHOT_MS, endMs: (i + 1) * SHOT_MS, x: 0.5, y: 0.3, style: "headline", size: 2.2, animation: "none", shadow: "none", ...c.title })),
    music: null,
  });
}

async function main() {
  const [picture, outArg] = process.argv.slice(2);
  if (!picture) throw new Error("usage: invert-stills.ts <picture.png> <out>");
  const out = path.resolve(outArg ?? "invert-stills");
  await mkdir(out, { recursive: true });
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-invert-"));
  await copyFile(picture, path.join(media, "wall.png"));
  const server = await serve(media);
  try {
    const assets: Record<string, ReelAsset> = { wall: { src: `${server.url}/wall.png`, kind: "IMAGE" } };
    const frames = CASES.map((_, i) => i * 30 + 15);
    const stills = await renderReelStills({ timeline: timeline(), assets, frames, dir: out, width: 1080, timeoutMs: 60_000 });
    CASES.forEach((c, i) => console.log(c.name, stills.get(frames[i])));
  } finally {
    server.close();
    await rm(media, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
