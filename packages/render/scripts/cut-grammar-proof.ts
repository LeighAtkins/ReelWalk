/**
 * The cut planner's proof on real footage (ADR 0087): Reel 91's seven clips planned to the cut grammar and rendered,
 * next to today's default cut of the same clips (the rule cut), with a cut-by-cut sheet.
 *
 *   FFMPEG=<ffmpeg> MEDIA=<dir with the clips> pnpm --filter @reelwalk/render exec tsx scripts/cut-grammar-proof.ts <outDir> plan
 *   FFMPEG=<ffmpeg> MEDIA=<dir> pnpm --filter @reelwalk/render exec tsx scripts/cut-grammar-proof.ts <outDir> render [--width 720]
 *
 * `plan` measures the clips with the stand-in analysis (stand-in-analysis.ts; a shot analysis from the worker, ADR
 * 0086, replaces it when `analyses.json` already holds one) and writes the plan, both timelines and the sheet's text.
 * `render` draws both reels, the stills either side of every cut, the sheet (HTML) and the side-by-side MP4. The local
 * render has no music: the song is not in the repository.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  autopilotStyle, clipSchema, cutGrammarReport, describeCutPlan, framePlan, parseTimeline, planCutOnTimeline, carryOpeningTitle, ruleCut,
  type PlannerAnalysis, type Timeline,
} from "@reelwalk/core";
import { renderReel, renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpegBin } from "./acceptance/ffmpeg";
import { serve } from "./smoke-fixture";
import { measureClip } from "./stand-in-analysis";

const run = promisify(execFile);

/** Reel 91 (cmvo10ubf000001ad160ggov8): its media, as get_reel lists them, with the rooms the namer gave. */
const CLIPS = [
  { clipId: "71fdb1bb-6f74-451f-babb-87bee14b1ed7", assetId: "cmvo11s8c000401adkaymy5uh", file: "aerial-4905.mp4", room: "aerial", width: 1920, height: 1080, durationMs: 22089 },
  { clipId: "20e0f51e-2884-4174-a37e-ad254aaec46f", assetId: "cmvo11z6s000701ad08fz4mb3", file: "exterior-4906.mp4", room: "exterior", width: 1920, height: 1080, durationMs: 9877 },
  { clipId: "a7193301-7c3d-45fd-8d77-ba02e23985ca", assetId: "cmvo11nfx000101adruyvdfgx", file: "kitchen-4904.mp4", room: "kitchen", width: 1080, height: 1920, durationMs: 12800 },
  { clipId: "c5c693ea-2707-4b13-be3e-fd9532c632aa", assetId: "cmvo12w28000g01adduji45li", file: "stairs-4908.mp4", room: "stairs", width: 1920, height: 1080, durationMs: 7841 },
  { clipId: "6d0d18ab-292a-4389-9473-805cc7283c7f", assetId: "cmvo138e4000j01ad84r5ptyd", file: "bedroom-4910.mp4", room: "primary bedroom", width: 1920, height: 1080, durationMs: 6306 },
  { clipId: "c0ecb33d-4269-411c-942c-0282cd58e2d9", assetId: "cmvo12vor000d01ads3vhf94u", file: "view-4909.mp4", room: "view", width: 1920, height: 1080, durationMs: 8242 },
  { clipId: "e663be43-0db9-4da7-a096-e7568cf9a2b0", assetId: "cmvo138s2000m01ad4uen65rq", file: "balcony-4911.mp4", room: "balcony", width: 1920, height: 1080, durationMs: 5906 },
];
/** Reel 91's song, Long Walks, at its stored tempo; not rendered (not in the repository), but it shapes the lengths. */
const MUSIC = { assetId: "cmvnlkljl003p01ad61i8p3m5", sourceStartMs: 0, volume: 0.8, bpm: 111.9, beatOffsetMs: 0 };
/** The reel's own headline (the live reel's), as the hook: Playfair, top 30 %, tracked in, carried across the first cut. */
const HOOK = "Live above it all";

function baseTimeline(): Timeline {
  return parseTimeline({
    version: 1, texts: [], music: MUSIC,
    clips: CLIPS.map((c) => clipSchema.parse({ id: c.clipId, assetId: c.assetId, kind: "VIDEO", room: c.room, sourceStartMs: 0, sourceEndMs: Math.min(3000, c.durationMs), volume: 0 })),
  });
}

function withHook(timeline: Timeline, endMs: number): Timeline {
  return { ...timeline, texts: [{ id: "hook", text: HOOK, startMs: 0, endMs, x: 0.5, y: 0.17, style: "elegant", color: "#ffffff", size: 1.25, shadow: "soft", animation: "auto", byApp: true }] };
}

async function plan(out: string, media: string) {
  const file = path.join(out, "analyses.json");
  let analyses: Record<string, PlannerAnalysis>;
  if (existsSync(file)) analyses = JSON.parse(await readFile(file, "utf8"));
  else {
    analyses = {};
    for (const c of CLIPS) {
      const t0 = Date.now();
      analyses[c.assetId] = await measureClip(path.join(media, c.file), c);
      console.log(`measured ${c.file} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    await writeFile(file, JSON.stringify(analyses));
  }
  const durations = Object.fromEntries(CLIPS.map((c) => [c.assetId, c.durationMs]));
  const base = withHook(baseTimeline(), 1500);
  const planned = planCutOnTimeline(base, { analyses, brief: { listing: "for-sale", feel: "classic" }, sourceDurationsMs: durations });
  let timeline = carryOpeningTitle(planned.timeline, planned.plan.carryUntilMs);
  timeline = { ...timeline, endCard: { text: "For sale", durationMs: 2000, reveal: "cut" } };
  const report = cutGrammarReport(timeline);

  // Today's default first cut of the same clips: the rule cut (ADR 0021/0024) with the style's hook.
  const assets = Object.fromEntries(CLIPS.map((c) => [c.assetId, { id: c.assetId, kind: "VIDEO" as const, title: c.file, durationMs: c.durationMs, width: c.width, height: c.height }]));
  let ids = 0;
  const today = ruleCut({ ...baseTimeline(), music: null }, { assets: assets as never, songs: [], info: {}, style: autopilotStyle("just-listed"), newId: () => `rule-${++ids}` });

  await writeFile(path.join(out, "planned.timeline.json"), JSON.stringify(timeline, null, 2));
  await writeFile(path.join(out, "default.timeline.json"), JSON.stringify(today, null, 2));
  await writeFile(path.join(out, "plan.json"), JSON.stringify({ plan: planned.plan, lines: describeCutPlan(planned.plan), report }, null, 2));
  console.log(describeCutPlan(planned.plan).join("\n"));
  console.log(`total ${(planned.plan.totalMs / 1000).toFixed(1)} s · reveal ${JSON.stringify(planned.plan.reveal)} · loop: ${planned.plan.loopSeam.technique} (${planned.plan.loopSeam.reason})`);
  console.log(`gate: ${report.pass ? "PASS" : "FAIL"} naked ${report.nakedCuts} repeats ${report.repeats} static ${report.longestStaticMs} ms, longest without a surprise ${report.longestNoSurpriseMs} ms`);
  for (const f of report.failures) console.log(`  fail: ${f.detail}`);
  for (const w of report.warnings) console.log(`  warn: ${w.detail}`);
  console.log(`default cut: ${today.clips.length} shots, ${(today.clips.reduce((s, c) => s + c.sourceEndMs - c.sourceStartMs, 0) / 1000).toFixed(1)} s`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function render(out: string, media: string, width: number) {
  const timeline = parseTimeline(JSON.parse(await readFile(path.join(out, "planned.timeline.json"), "utf8")));
  const today = parseTimeline(JSON.parse(await readFile(path.join(out, "default.timeline.json"), "utf8")));
  const server = await serve(media);
  try {
    const assets: Record<string, ReelAsset> = Object.fromEntries(CLIPS.map((c) => [c.assetId, { src: `${server.url}/${c.file}`, kind: "VIDEO" as const, durationMs: c.durationMs }]));
    // The stills either side of every cut, and the middle of a drawn transition.
    const fp = framePlan(timeline, 30);
    const frames = fp.clips.slice(1).flatMap((entry) => [entry.from - 1, entry.from, entry.from + 3]);
    const stillsDir = path.join(out, "stills");
    await mkdir(stillsDir, { recursive: true });
    let t0 = Date.now();
    const made = await renderReelStills({ timeline, assets, frames, dir: stillsDir, width: 270, timeoutMs: 240_000 });
    console.log(`stills: ${made.size} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const rows = fp.clips.slice(1).map((entry, i) => {
      const cut = entry.clip.cut;
      const img = (f: number) => (made.get(f) ? `<img src="stills/${path.basename(made.get(f)!)}" width="135">` : "(not drawn)");
      return `<tr><td>${i + 1}<br>${(entry.from / 30).toFixed(2)} s</td><td>${img(entry.from - 1)}</td><td>${img(entry.from)}</td><td>${img(entry.from + 3)}</td><td><b>${cut?.technique ?? "NAKED"}</b><br><small>${entry.clip.transitionIn}</small>${cut?.surprise ? `<br><i>surprise: ${esc(cut.surprise)}</i>` : ""}</td><td>${esc(cut?.reason ?? "")}</td><td>${cut?.eyeTrace === undefined ? "–" : `${Math.round(cut.eyeTrace * 100)} %`}</td></tr>`;
    });
    const report = JSON.parse(await readFile(path.join(out, "plan.json"), "utf8"));
    await writeFile(path.join(out, "cut-sheet.html"), `<!doctype html><meta charset="utf-8"><title>Reel 91 cut sheet</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#eee}td{border-top:1px solid #333;padding:6px;vertical-align:top}th{text-align:left;color:#aaa}small,i{color:#aaa}</style>
<h1>Reel 91, planned to the cut grammar (ADR 0087)</h1><p>${esc(report.lines.length + " shots, " + (report.plan.totalMs / 1000).toFixed(1) + " s; gate " + (report.report.pass ? "PASS" : "FAIL"))}. Stills at 270 px from the real renderer. Analysis: local stand-in (no depth model, no colour).</p>
<table><tr><th>cut</th><th>last frame of A</th><th>first frame of B</th><th>B +3 frames</th><th>technique</th><th>reason</th><th>eye trace</th></tr>${rows.join("\n")}</table>`);

    t0 = Date.now();
    await renderReel({ timeline, assets, output: path.join(out, "reel91-cut-grammar.mp4"), width, concurrency: 2 }, () => undefined);
    console.log(`planned reel: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    t0 = Date.now();
    await renderReel({ timeline: today, assets, output: path.join(out, "reel91-default.mp4"), width, concurrency: 2 }, () => undefined);
    console.log(`default reel: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // Side by side: today's default on the left, the planned cut on the right; the shorter one holds its last frame.
    await run(ffmpegBin(), ["-v", "error", "-y", "-i", path.join(out, "reel91-default.mp4"), "-i", path.join(out, "reel91-cut-grammar.mp4"), "-filter_complex",
      "[0:v]scale=360:640,tpad=stop_mode=clone:stop_duration=60,drawtext=text='today (rule cut)':x=12:y=12:fontcolor=white:fontsize=20:box=1:boxcolor=black@0.5[a];[1:v]scale=360:640,tpad=stop_mode=clone:stop_duration=60,drawtext=text='cut grammar':x=12:y=12:fontcolor=white:fontsize=20:box=1:boxcolor=black@0.5[b];[a][b]hstack=inputs=2,trim=duration=" + Math.ceil(timeline.clips.reduce((s, c) => s + c.sourceEndMs - c.sourceStartMs, 0) / 1000 + 1) + "[v]",
      "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", path.join(out, "side-by-side.mp4")]).catch(async (error) => {
      // An ffmpeg without drawtext: the same, unlabelled.
      console.log(`side by side with labels failed (${String(error).split("\n")[0]}); without labels`);
      await run(ffmpegBin(), ["-v", "error", "-y", "-i", path.join(out, "reel91-default.mp4"), "-i", path.join(out, "reel91-cut-grammar.mp4"), "-filter_complex",
        "[0:v]scale=360:640,tpad=stop_mode=clone:stop_duration=60[a];[1:v]scale=360:640,tpad=stop_mode=clone:stop_duration=60[b];[a][b]hstack=inputs=2[v]", "-map", "[v]", "-t", "45", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", path.join(out, "side-by-side.mp4")]);
    });
  } finally {
    server.close();
  }
}

async function main() {
  const [outArg, mode] = process.argv.slice(2);
  const out = path.resolve(outArg ?? "cut-grammar-out");
  const media = process.env.MEDIA;
  if (!media) throw new Error("MEDIA=<dir with the clips> is required");
  await mkdir(out, { recursive: true });
  const widthAt = process.argv.indexOf("--width");
  if (mode === "render") await render(out, media, widthAt > 0 ? Number(process.argv[widthAt + 1]) : 720);
  else await plan(out, media);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
