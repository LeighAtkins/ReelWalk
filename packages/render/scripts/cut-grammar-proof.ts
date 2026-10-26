/**
 * The cut planner's proof on real footage (ADR 0087): Reel 91's seven clips cut by the planner and rendered, next to
 * today's default cut of the same clips (the rule cut), with a cut-by-cut sheet.
 *
 *   FFMPEG=<ffmpeg> MEDIA=<dir with the clips> [ANALYSES=<ADR 0086 fixture>] pnpm --filter @reelwalk/render exec tsx scripts/cut-grammar-proof.ts <outDir> plan
 *   FFMPEG=<ffmpeg> MEDIA=<dir> pnpm --filter @reelwalk/render exec tsx scripts/cut-grammar-proof.ts <outDir> render [--width 720]
 *
 * `plan` reads the clips' shot analysis (`ANALYSES`, the worker's real measurements in ADR 0086's fixture; without it
 * they are measured with stand-in-analysis.ts) and makes both first cuts through the app's own functions: the rule
 * cut and the planner's (`plannedCut`), same style, same song, same hook words. `render` places the hook where the
 * rendered opening measures 4.5:1 (refusing otherwise), then draws both reels, the stills either side of every cut,
 * the sheet and the side-by-side. The song (Long Walks, an Instagram sound the app never renders into an export) is
 * drawn into both here so the comparison is heard, when `MEDIA` holds `longwalks.m4a`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  autopilotStyle, clipSchema, cutGrammarReport, describeCutPlan, framePlan, HOOK_CONTRAST_MIN, lumaFromRgba, measuredContrast, parseTimeline, pickTitleSpot, plannedCut, ruleCut,
  type PlannerAnalysis, type Timeline,
} from "@reelwalk/core";
import { renderReel, renderReelStills } from "../src/render-reel";
import type { ReelAsset } from "../src/reel/types";
import { ffmpegBin, readImage } from "./acceptance/ffmpeg";
import type { Rgb } from "./acceptance/image";
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
/** Reel 91's song, Long Walks, with its stored grid (get_reel, revision 24). */
const SONG = { id: "cmvnlkljl003p01ad61i8p3m5", title: "Long Walks", bpm: 111.9, beatOffsetMs: 534, file: "longwalks.m4a", durationMs: 248995 };
const SONG_DOWNBEATS = [2143, 4287, 6432, 8577, 10722, 12866, 15011, 17156, 19301, 21446, 23590, 25735, 27880, 30025, 32169, 34314, 36459, 38604, 40748, 42893, 45038];

function baseTimeline(): Timeline {
  return parseTimeline({
    version: 1, texts: [], music: null,
    clips: CLIPS.map((c) => clipSchema.parse({ id: c.clipId, assetId: c.assetId, kind: "VIDEO", room: c.room, sourceStartMs: 0, sourceEndMs: Math.min(3000, c.durationMs), volume: 0 })),
  });
}

/** The app's context for both first cuts: the clips and the song as the library lists them, the just-listed style. */
function context() {
  const assets = {
    ...Object.fromEntries(CLIPS.map((c) => [c.assetId, { id: c.assetId, kind: "VIDEO" as const, title: c.file, durationMs: c.durationMs, width: c.width, height: c.height }])),
    [SONG.id]: { id: SONG.id, kind: "AUDIO" as const, title: SONG.title, durationMs: SONG.durationMs, bpm: SONG.bpm, beatOffsetMs: SONG.beatOffsetMs },
  };
  let ids = 0;
  return { assets: assets as never, songs: [{ id: SONG.id, title: SONG.title, bpm: SONG.bpm, mood: null }], info: {}, style: autopilotStyle("just-listed"), newId: () => `new-${++ids}` };
}

const seconds = (t: Timeline) => (t.clips.reduce((s, c) => s + c.sourceEndMs - c.sourceStartMs, 0) / 1000).toFixed(1);

async function plan(out: string, media: string) {
  const file = path.join(out, "analyses.json");
  let analyses: Record<string, PlannerAnalysis>;
  if (process.env.ANALYSES) {
    const fixture = JSON.parse(await readFile(process.env.ANALYSES, "utf8")) as { note?: string; clips: Record<string, { analysis: PlannerAnalysis }> };
    analyses = Object.fromEntries(Object.entries(fixture.clips).map(([id, clip]) => [id, clip.analysis]));
    console.log(`analyses: ${fixture.note ?? process.env.ANALYSES}`);
    await writeFile(file, JSON.stringify(analyses));
  } else if (existsSync(file)) analyses = JSON.parse(await readFile(file, "utf8"));
  else {
    analyses = {};
    for (const c of CLIPS) analyses[c.assetId] = await measureClip(path.join(media, c.file), c);
    await writeFile(file, JSON.stringify(analyses));
  }
  const durations = Object.fromEntries(CLIPS.map((c) => [c.assetId, c.durationMs]));
  // The planner's first cut, as Make it for me makes it (Classic, the question screens' default feel).
  const planned = plannedCut(baseTimeline(), { ...context(), analyses, brief: { listing: "for-sale", feel: "classic" }, sourceDurationsMs: durations });
  if (!planned) throw new Error("plannedCut stepped aside (no analyses, or the plan failed its own gate)");
  const timeline: Timeline = { ...planned.timeline, music: planned.timeline.music && { ...planned.timeline.music, downbeats: SONG_DOWNBEATS } };
  const report = cutGrammarReport(timeline);
  // Today's default first cut of the same clips: the rule cut with the same song and style.
  const today = ruleCut(baseTimeline(), context());

  await writeFile(path.join(out, "planned.timeline.json"), JSON.stringify(timeline, null, 2));
  await writeFile(path.join(out, "default.timeline.json"), JSON.stringify(today, null, 2));
  await writeFile(path.join(out, "plan.json"), JSON.stringify({ plan: planned.plan, lines: describeCutPlan(planned.plan), report }, null, 2));
  console.log(describeCutPlan(planned.plan).join("\n"));
  console.log(`total ${seconds(timeline)} s · reveal ${JSON.stringify(planned.plan.reveal)} · loop: ${planned.plan.loopSeam.technique} (${planned.plan.loopSeam.reason})`);
  console.log(`gate: ${report.pass ? "PASS" : "FAIL"} naked ${report.nakedCuts} repeats ${report.repeats} static ${report.longestStaticMs} ms, longest without a surprise ${report.longestNoSurpriseMs} ms`);
  for (const f of report.failures) console.log(`  fail: ${f.detail}`);
  for (const w of report.warnings) console.log(`  warn: ${w.detail}`);
  for (const n of planned.plan.notes) console.log(`  note: ${n}`);
  console.log(`end card: ${JSON.stringify(timeline.endCard)}`);
  console.log(`default cut: ${today.clips.length} shots, ${seconds(today)} s`);
}

function rgba(img: Rgb): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) { out[i * 4] = img.data[i * 3]; out[i * 4 + 1] = img.data[i * 3 + 1]; out[i * 4 + 2] = img.data[i * 3 + 2]; out[i * 4 + 3] = 255; }
  return out;
}

/** The hook placed where the opening (drawn without titles) measures 4.5:1 on both frames read; refused when nowhere does. */
async function placeHook(out: string, timeline: Timeline, assets: Record<string, ReelAsset>): Promise<{ timeline: Timeline; contrast: number }> {
  const hook = timeline.texts.find((t) => t.startMs <= 100 && !t.id.startsWith("room-"));
  if (!hook) return { timeline, contrast: Infinity };
  const dir = path.join(out, "placement");
  await mkdir(dir, { recursive: true });
  const frames = [6, Math.round((hook.endMs * 30) / 1000) - 6];
  const made = await renderReelStills({ timeline: { ...timeline, texts: [] }, assets, frames, dir, width: 270, timeoutMs: 120_000 });
  const lumas = await Promise.all(frames.map(async (f) => { const img = await readImage(made.get(f)!); return lumaFromRgba(rgba(img), img.width, img.height); }));
  // The line's box: the elegant face at the hook's size, about half an em a character, one line plus leading.
  const fontPx = 76 * 0.7 * hook.size;
  const size = { w: Math.min(0.86, (hook.text.length * 0.52 * fontPx) / 1080), h: (fontPx * 1.3) / 1920 };
  const candidates = [0.13, 0.16, 0.19, 0.22, 0.25, 0.28];
  // A spot must hold on every frame read: the hook is on screen across the first cut.
  let best: { y: number; color: "#ffffff" | "#111111"; shadow: "strong" | "soft"; contrast: number } | null = null;
  for (const y of candidates) {
    for (const ink of [{ color: "#ffffff" as const, shadow: "strong" as const }, { color: "#111111" as const, shadow: "soft" as const }]) {
      const box = { x: 0.5 - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h };
      const contrast = Math.min(...lumas.map((frame) => measuredContrast(frame, box, ink) ?? 0));
      if (contrast >= HOOK_CONTRAST_MIN && (!best || (best.color !== "#ffffff" && ink.color === "#ffffff") || (best.color === ink.color && contrast > best.contrast))) best = { y, ...ink, contrast };
    }
  }
  console.log(`hook spots per frame: ${JSON.stringify(lumas.map((frame) => pickTitleSpot(frame, size, candidates)))}`);
  if (!best) throw new Error("No place in the top 30 % of the opening reaches 4.5:1 on every frame: the hook is refused.");
  const placed = { ...timeline, texts: timeline.texts.map((t) => (t.id === hook.id ? { ...t, y: best!.y, color: best!.color, shadow: best!.shadow } : t)) };
  return { timeline: placed, contrast: best.contrast };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function render(out: string, media: string, width: number) {
  let timeline = parseTimeline(JSON.parse(await readFile(path.join(out, "planned.timeline.json"), "utf8")));
  const today = parseTimeline(JSON.parse(await readFile(path.join(out, "default.timeline.json"), "utf8")));
  const server = await serve(media);
  try {
    const assets: Record<string, ReelAsset> = Object.fromEntries(CLIPS.map((c) => [c.assetId, { src: `${server.url}/${c.file}`, kind: "VIDEO" as const, durationMs: c.durationMs }]));
    if (existsSync(path.join(media, SONG.file))) assets[SONG.id] = { src: `${server.url}/${SONG.file}`, kind: "AUDIO", durationMs: SONG.durationMs };
    else console.log("no song in MEDIA: rendering silent");
    const placed = await placeHook(out, timeline, assets);
    timeline = placed.timeline;
    await writeFile(path.join(out, "planned.timeline.json"), JSON.stringify(timeline, null, 2));
    const hook = timeline.texts.find((t) => t.startMs <= 100);
    console.log(`hook "${hook?.text}" at y ${hook?.y}, ${hook?.color} ${hook?.shadow}, measured ${placed.contrast}:1`);

    // The stills either side of every cut, and three frames into the next shot.
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
    await writeFile(path.join(out, "cut-sheet.html"), `<!doctype html><meta charset="utf-8"><title>Reel 91 cut sheet (v2)</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#eee}td{border-top:1px solid #333;padding:6px;vertical-align:top}th{text-align:left;color:#aaa}small,i{color:#aaa}</style>
<h1>Reel 91, planned to the cut grammar (ADR 0087), v2</h1><p>${esc(`${report.lines.length} shots, ${seconds(timeline)} s; gate ${report.report.pass ? "PASS" : "FAIL"}; hook measured ${placed.contrast}:1`)}. Stills at 270 px from the real renderer. Analysis: ADR 0086's worker measurements of Reel 91.</p>
<table><tr><th>cut</th><th>last frame of A</th><th>first frame of B</th><th>B +3 frames</th><th>technique</th><th>reason</th><th>eye trace</th></tr>${rows.join("\n")}</table>`);

    t0 = Date.now();
    await renderReel({ timeline, assets, output: path.join(out, "reel91-cut-grammar.mp4"), width, concurrency: 2 }, () => undefined);
    console.log(`planned reel: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    t0 = Date.now();
    await renderReel({ timeline: today, assets, output: path.join(out, "reel91-default.mp4"), width, concurrency: 2 }, () => undefined);
    console.log(`default reel: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // Side by side: today's default on the left, the planned cut on the right; the shorter one holds its last frame.
    // The sound is the planned cut's (the same song from its start on both).
    const longest = Math.ceil(Math.max(Number(seconds(timeline)), Number(seconds(today))) + 0.5);
    await run(ffmpegBin(), ["-v", "error", "-y", "-i", path.join(out, "reel91-default.mp4"), "-i", path.join(out, "reel91-cut-grammar.mp4"), "-filter_complex",
      "[0:v]scale=360:640,tpad=stop_mode=clone:stop_duration=60,drawtext=text='today (rule cut)':x=12:y=12:fontcolor=white:fontsize=20:box=1:boxcolor=black@0.5[a];" +
      "[1:v]scale=360:640,tpad=stop_mode=clone:stop_duration=60,drawtext=text='cut grammar v2':x=12:y=12:fontcolor=white:fontsize=20:box=1:boxcolor=black@0.5[b];[a][b]hstack=inputs=2[v]",
      "-map", "[v]", "-map", "1:a?", "-t", String(longest), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-c:a", "aac", path.join(out, "side-by-side.mp4")], { maxBuffer: 1 << 26 });
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
