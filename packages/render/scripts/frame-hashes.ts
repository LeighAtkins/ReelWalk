/**
 * Frame hashes of the smoke reel's titled frames (ADR 0046): renders chosen
 * frames at full size as PNG and prints a SHA-256 of each, so a refactor of
 * title placement can show it moved no pixel. Run it before and after a change
 * and compare.
 *
 *   tsx scripts/frame-hashes.ts ./out                 # writes out/frame-NNN.png and out/hashes.json
 *   tsx scripts/frame-hashes.ts ./out ./before.json   # and compares with an earlier run
 *
 * Needs ffmpeg and a Chrome the renderer can use, like render-smoke.ts (run it
 * in the worker image).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { REEL_COMPOSITION_ID, type ReelAsset } from "../src/reel/types";
import { makeMedia, serve, smokeTimeline } from "./smoke-fixture";

/** The behind title over its matte (10, 40), the pinned and surfaced titles across the room shot (75–146), the typewriter and the drift. */
const FRAMES = [10, 40, 75, 90, 110, 130, 146, 160, 200, 230];

async function main() {
  const out = path.resolve(process.argv[2] ?? "frame-hashes");
  const against = process.argv[3] ? path.resolve(process.argv[3]) : null;
  await mkdir(out, { recursive: true });
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-hashes-"));
  const server = await serve(media);
  try {
    await makeMedia(media);
    const assets: Record<string, ReelAsset> = {
      walk: { src: `${server.url}/walk.mp4`, kind: "VIDEO" },
      room: { src: `${server.url}/room.mp4`, kind: "VIDEO" },
      photo: { src: `${server.url}/photo.jpg`, kind: "IMAGE" },
      pano: { src: `${server.url}/pano.jpg`, kind: "IMAGE" },
      song: { src: `${server.url}/song.m4a`, kind: "AUDIO" },
    };
    const serveUrl = await bundle({ entryPoint: path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"), webpackOverride: (config) => config });
    const inputProps = { timeline: smokeTimeline(), assets, watermark: false };
    const composition = await selectComposition({ serveUrl, id: REEL_COMPOSITION_ID, inputProps });
    const hashes: Record<string, string> = {};
    for (const frame of FRAMES) {
      const output = path.join(out, `frame-${String(frame).padStart(3, "0")}.png`);
      await renderStill({ composition, serveUrl, inputProps, output, frame, imageFormat: "png", timeoutInMilliseconds: 60_000 });
      hashes[frame] = createHash("sha256").update(await readFile(output)).digest("hex");
      console.log(`frame ${frame}: ${hashes[frame]}`);
    }
    await writeFile(path.join(out, "hashes.json"), JSON.stringify(hashes, null, 2));
    if (against) {
      const before = JSON.parse(await readFile(against, "utf8")) as Record<string, string>;
      const moved = FRAMES.filter((frame) => before[frame] !== hashes[frame]);
      console.log(moved.length ? `frame-hashes: ${moved.length} of ${FRAMES.length} frames differ: ${moved.join(", ")}` : `frame-hashes: all ${FRAMES.length} frames identical`);
    }
  } finally {
    server.close();
    await rm(media, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("frame-hashes: FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
