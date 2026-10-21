/**
 * Render smoke test (ADR 0042): build a reel that uses every feature the
 * composition has, then draw the first and last frame of every shot with the
 * real renderer. Anything that errors or hangs fails here, in CI or on a
 * laptop, instead of in a production export six minutes in.
 *
 *   pnpm --filter @reelwalk/render smoke            # stills in a temp dir
 *   pnpm --filter @reelwalk/render smoke ./out      # keep the stills here
 *
 * Needs ffmpeg (to make the fixture media) and a Chrome the renderer can use
 * (the worker image has both); FFMPEG / FFPROBE name other binaries. Media is
 * served from a local HTTP server, the way the worker hands the renderer signed URLs.
 *
 * The walking shot is real footage of a person (packages/render/fixtures/reader.mp4,
 * see SOURCE.md) when the fixture is there, a test pattern otherwise.
 *
 * SMOKE_COMPARE=1 adds the acceptance checks (ADR 0053): the exported frames
 * against stills of the same frames ("preview matches export"), against the
 * baseline references (SMOKE_BASELINE=report|strict|update), and every planar
 * title held to its plane at five frames. Contact sheets and acceptance.json go
 * to the output directory (or SMOKE_OUT).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Timeline } from "@reelwalk/core";
import { preflightReel, reelCheckpoints, renderReel } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffprobeBin } from "./acceptance/ffmpeg";
import { runAcceptance } from "./acceptance/run";
import { makeMedia, serve, smokeTimeline } from "./smoke-fixture";

// The fixture lives in smoke-fixture.ts; re-exported for anything that imported it from here.
export { smokeTimeline };

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

/** The streams of a finished MP4, as ffprobe sees them: the export must carry video and audio of the right size and length. */
async function probe(file: string): Promise<{ streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } }> {
  const { stdout } = await run(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  return JSON.parse(stdout);
}

async function main() {
  const keepIn = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  if (keepIn) await mkdir(keepIn, { recursive: true });
  const media = await mkdtemp(path.join(os.tmpdir(), "reelwalk-smoke-"));
  const server = await serve(media);
  const started = Date.now();
  try {
    const { real } = await makeMedia(media);
    console.log(real ? "smoke: the walking shot is real footage (fixtures/reader.mp4)" : "smoke: fixtures/reader.mp4 is missing, so the walking shot is a test pattern (no real person for the matte or the window title)");
    const assets: Record<string, ReelAsset> = {
      walk: { src: `${server.url}/walk.mp4`, kind: "VIDEO" },
      room: { src: `${server.url}/room.mp4`, kind: "VIDEO" },
      photo: { src: `${server.url}/photo.jpg`, kind: "IMAGE" },
      pano: { src: `${server.url}/pano.jpg`, kind: "IMAGE" },
      song: { src: `${server.url}/song.m4a`, kind: "AUDIO" },
    };
    const timeline = smokeTimeline();
    const points = reelCheckpoints(timeline);
    console.log(`smoke: ${timeline.clips.length} shots, ${points.length} checkpoints`);
    const stills = await preflightReel({ timeline, assets, keepIn, timeoutMs: 40_000 }, (done, total) => console.log(`  ${done}/${total}`));
    console.log(`smoke: ${stills.length} frames drew in ${Math.round((Date.now() - started) / 1000)} s${keepIn ? ` → ${keepIn}` : ""}`);
    // Then a real export of the first shots: stills prove the frames draw, only an MP4 proves the encode, the
    // audio mux and the duration (ADR 0042, review of 2026-10-20). Short, so CI stays quick.
    const short: Timeline = { ...timeline, clips: timeline.clips.slice(0, 2), texts: timeline.texts.filter((text) => text.startMs < 4900) };
    const output = path.join(keepIn ?? media, "smoke.mp4");
    await renderReel({ timeline: short, assets, output, concurrency: 2 }, () => undefined);
    const info = await probe(output);
    const video = info.streams.find((stream) => stream.codec_type === "video");
    const audio = info.streams.find((stream) => stream.codec_type === "audio");
    const seconds = Number(info.format.duration);
    if (!video || video.width !== 1080 || video.height !== 1920) throw new Error(`smoke: the MP4 has no 1080×1920 video stream (${JSON.stringify(video)})`);
    if (!audio) throw new Error("smoke: the MP4 has no audio stream");
    if (!(seconds > 4.5 && seconds < 5.5)) throw new Error(`smoke: the MP4 is ${seconds.toFixed(2)} s, expected about 4.9 s`);
    console.log(`smoke: MP4 ${seconds.toFixed(2)} s with video and audio, in ${Math.round((Date.now() - started) / 1000)} s`);
    if (process.env.SMOKE_COMPARE === "1") {
      const outDir = process.env.SMOKE_OUT ? path.resolve(process.env.SMOKE_OUT) : path.join(keepIn ?? media, "acceptance");
      const report = await runAcceptance({
        timeline: short, assets, video: output, outDir, fps: 30,
        baselineDir: path.join(here, "..", "fixtures", "baseline"), baselineMode: process.env.SMOKE_BASELINE ?? "report",
      });
      console.log(`smoke: acceptance report and contact sheets → ${outDir}`);
      if (report.failures.length) throw new Error(`acceptance failed:\n  - ${report.failures.join("\n  - ")}`);
      console.log(`smoke: acceptance ok in ${Math.round((Date.now() - started) / 1000)} s`);
    }
    console.log(`smoke: ok in ${Math.round((Date.now() - started) / 1000)} s total`);
  } finally {
    server.close();
    await rm(media, { recursive: true, force: true });
  }
}

// Run when executed, not when imported (the fixture timeline is reused by tests and calibration).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("smoke: FAILED:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
