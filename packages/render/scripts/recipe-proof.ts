/**
 * The proof renders of ADR 0090: recipe 5 ("a day at") and a walkthrough with motion-hidden cuts, on real footage, with
 * the real renderer.
 *
 *   FFMPEG=<full ffmpeg> pnpm --filter @reelwalk/render exec tsx scripts/recipe-proof.ts <spec.json> <outDir> [--width 720] [--no-export]
 *
 * The spec names a media folder (the clips as <id>.mp4 and the song), the clips' measured motion and colour (the
 * shot-analysis sample shape of ADR 0086 plus ADR 0070 colour statistics, as made by a local stand-in analyser), and either
 *   - `"mode": "day"`: shots with their roles and times of day for `planDayAt`, the song analysed by core's own
 *     `analyseAudio` (ADR 0059) exactly as an upload is; or
 *   - `"mode": "cut"`: clips in order with their windows in beats, and which cuts to try as motion cuts through the
 *     `setMotionCut` command (refusals are printed and kept as hard cuts).
 * Writes timeline.json, report.json, reel.mp4 and, for each motion cut, a strip of the 8 frames either side.
 * The footage is not committed (Pexels; see docs/licences/recipes-2026-10-26.md).
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  analyseAudio,
  applyCommand,
  BEAT_SAMPLE_RATE,
  emptyTimeline,
  framePlan,
  parseTimeline,
  planDayAt,
  type Clip,
  type ColorStats,
  type DayShot,
  type MotionSampleLike,
  type Timeline,
} from "@reelwalk/core";
import { renderReel, renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpegBin } from "./acceptance/ffmpeg";
import { serve } from "./smoke-fixture";

const run = promisify(execFile);

type Measured = Record<string, { fps: number; durationMs: number; samples: MotionSampleLike[]; colorStats: ColorStats; width?: number; height?: number }>;
type Spec = {
  mode: "day" | "cut";
  media: string;
  measure: string;
  /** Source size by clip id (for the crop of a landscape clip); portrait 1080×1920 when absent. */
  sizes?: Record<string, [number, number]>;
  song: { file: string; startMs?: number; volume?: number };
  shots?: (Omit<DayShot, "clip" | "sourceDurationMs" | "colorStats"> & { id: string })[];
  lines?: { credit?: string; place?: string };
  clips?: { id: string; fromMs: number; beats: number }[];
  motionCuts?: number[];
};

async function decodeMono(file: string, rate: number): Promise<Float32Array> {
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 1 << 30 });
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
}

const videoClip = (id: string, sourceStartMs: number, sourceEndMs: number): Clip =>
  parseTimeline({ ...emptyTimeline(), clips: [{ id, assetId: id, kind: "VIDEO", sourceStartMs, sourceEndMs, volume: 0 }], texts: [] }).clips[0];

async function main() {
  const args = process.argv.slice(2);
  const [specFile, outArg] = args.filter((arg) => !arg.startsWith("-"));
  const width = Number(args[args.indexOf("--width") + 1]) || 720;
  const spec: Spec = JSON.parse(await readFile(specFile, "utf8"));
  const out = path.resolve(outArg);
  await mkdir(out, { recursive: true });
  const measured: Measured = JSON.parse(await readFile(spec.measure, "utf8"));
  const songPath = path.join(spec.media, spec.song.file);
  const samples = await decodeMono(songPath, BEAT_SAMPLE_RATE);
  const analysis = analyseAudio(samples, BEAT_SAMPLE_RATE);
  const songMs = Math.round((samples.length / BEAT_SAMPLE_RATE) * 1000);
  console.log(`song: ${analysis.bpm} bpm, first beat ${analysis.beatOffsetMs} ms, analysed ${analysis.durationMs} of ${songMs} ms, sections ${analysis.sections.map((s) => `${s.kind}@${s.startMs}`).join(" ")}, drop ${analysis.drop?.atMs ?? "none"}`);
  const durations: Record<string, number> = Object.fromEntries(Object.entries(measured).map(([id, m]) => [id, m.durationMs]));
  const aspect = (id: string) => { const [w, h] = spec.sizes?.[id] ?? [1080, 1920]; return { width: w, height: h }; };

  let timeline: Timeline;
  let report: unknown;
  if (spec.mode === "day") {
    const shots: DayShot[] = (spec.shots ?? []).map(({ id, ...facts }) => ({ ...facts, clip: videoClip(id, 0, Math.min(3000, durations[id])), sourceDurationMs: durations[id], colorStats: measured[id].colorStats }));
    let n = 0;
    const planned = planDayAt({ ...emptyTimeline() }, shots, {
      assetId: "song", bpm: analysis.bpm ?? 0, beatOffsetMs: analysis.beatOffsetMs ?? 0, durationMs: songMs, energy: analysis.energy, sections: analysis.sections, drop: analysis.drop, volume: spec.song.volume,
    }, spec.lines ?? {}, () => `t${++n}`);
    timeline = planned.timeline;
    // The colour guess, for the record: what phaseFromColour would have said for each tagged shot.
    report = { ...planned.report, analysis: { bpm: analysis.bpm, beatOffsetMs: analysis.beatOffsetMs, sections: analysis.sections, drop: analysis.drop } };
  } else {
    const beatMs = 60_000 / (analysis.bpm ?? 120);
    const clips = (spec.clips ?? []).map((entry) => videoClip(entry.id, entry.fromMs, Math.round(entry.fromMs + entry.beats * beatMs)));
    const start = spec.song.startMs ?? 0;
    // Start the song on a beat so every whole-beat cut lands on one.
    const songStartMs = Math.round((analysis.beatOffsetMs ?? 0) + Math.round((start - (analysis.beatOffsetMs ?? 0)) / beatMs) * beatMs);
    timeline = parseTimeline({ ...emptyTimeline(), clips: clips.map((clip) => ({ ...clip, filter: "warm" })), texts: [],
      music: { assetId: "song", sourceStartMs: songStartMs, volume: spec.song.volume ?? 0.9, bpm: analysis.bpm, beatOffsetMs: analysis.beatOffsetMs } });
    const cuts: unknown[] = [];
    for (const index of spec.motionCuts ?? []) {
      const before = timeline.clips[index - 1], clip = timeline.clips[index];
      const analyses = Object.fromEntries([before.assetId, clip.assetId].map((id) => [id, { samples: measured[id].samples, ...aspect(id) }]));
      const result = applyCommand(timeline, { type: "setMotionCut", clipId: clip.id, analyses }, { generation: 1, sourceDurationsMs: durations });
      if (result.rejected) {
        console.log(`cut ${index} (${before.assetId} → ${clip.assetId}): refused — ${result.rejected}`);
        cuts.push({ index, refused: result.rejected });
      } else {
        timeline = result.timeline;
        const made = timeline.clips[index].motionCut!;
        console.log(`cut ${index} (${before.assetId} → ${clip.assetId}): motion cut, out ${JSON.stringify(made.out)} in ${JSON.stringify(made.in)} ramp ${made.rampFrom}× over ${made.rampFrames}`);
        cuts.push({ index, out: made.out, in: made.in, rampFrom: made.rampFrom, rampFrames: made.rampFrames });
      }
    }
    // Every other pair, as the gate sees it, for the record (would a motion cut have been allowed there?).
    const gate = timeline.clips.slice(1).map((clip, i) => {
      const before = timeline.clips[i];
      const analyses = Object.fromEntries([before.assetId, clip.assetId].map((id) => [id, { samples: measured[id].samples, ...aspect(id) }]));
      const probe = clip.transitionIn === "motionCut" ? null : applyCommand(timeline, { type: "setMotionCut", clipId: clip.id, analyses }, { generation: 1, sourceDurationsMs: durations });
      return { cut: i + 1, from: before.assetId, to: clip.assetId, motionCut: clip.transitionIn === "motionCut", gate: probe ? (probe.rejected ?? "would be allowed") : "made" };
    });
    report = { songStartMs, beatMs, cuts, gate, analysis: { bpm: analysis.bpm, beatOffsetMs: analysis.beatOffsetMs } };
  }
  await writeFile(path.join(out, "timeline.json"), JSON.stringify(timeline, null, 2));
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1).slice(0, 4000));

  const server = await serve(spec.media);
  try {
    const assets: Record<string, ReelAsset> = Object.fromEntries(Object.keys(measured).map((id) => [id, { src: `${server.url}/${id}.mp4`, kind: "VIDEO" as const, durationMs: durations[id] }]));
    assets.song = { src: `${server.url}/${spec.song.file}`, kind: "AUDIO", durationMs: songMs };
    // The frames either side of each motion cut, drawn by the real renderer, tiled into one strip per cut.
    const plan = framePlan(timeline, 30);
    const motionCuts = plan.clips.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.clip.transitionIn === "motionCut");
    for (const { entry, index } of motionCuts) {
      const frames = Array.from({ length: 16 }, (_, k) => entry.from - 8 + k);
      const dir = path.join(out, `cut-${index}`);
      const made = await renderReelStills({ timeline, assets, frames, dir, width: 270, timeoutMs: 180_000 });
      const tmp = path.join(out, `tmp-${index}`);
      await mkdir(tmp, { recursive: true });
      for (const [k, frame] of frames.entries()) { const file = made.get(frame); if (file) await copyFile(file, path.join(tmp, `${String(k).padStart(3, "0")}.png`)); }
      await run(ffmpegBin(), ["-v", "error", "-y", "-i", path.join(tmp, "%03d.png"), "-vf", "tile=8x2:padding=4:color=white", "-frames:v", "1", path.join(out, `cut-${index}-frames.png`)]);
      await rm(tmp, { recursive: true, force: true });
      console.log(`cut ${index}: frames ${frames[0]}–${frames.at(-1)} → cut-${index}-frames.png`);
    }
    if (!args.includes("--no-export")) {
      const output = path.join(out, "reel.mp4");
      const t0 = Date.now();
      await renderReel({ timeline, assets, output, concurrency: 2, width }, () => undefined);
      console.log(`export: ${((Date.now() - t0) / 1000).toFixed(1)} s → ${output}`);
    }
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
