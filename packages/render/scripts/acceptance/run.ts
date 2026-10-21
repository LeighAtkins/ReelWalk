/**
 * The acceptance checks the render smoke runs with SMOKE_COMPARE=1 (ADR 0053):
 *
 * 1. Preview matches export: five frames of every shot, drawn as stills by the
 *    composition with the props the editor passes (`renderReelStills`), against
 *    the same frames of the exported MP4.
 * 2. Baseline: the export's frames against the reference PNGs in
 *    packages/render/fixtures/baseline (report-only unless SMOKE_BASELINE=strict;
 *    SMOKE_BASELINE=update writes them).
 * 3. Motion attachment: every planar title, at five frames, drawn with and
 *    without it; its glyphs must lie on its plane and keep their place in it.
 *
 * Writes contact sheets and a JSON report to `outDir` and returns the failures.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { framePlan, type Timeline } from "@reelwalk/core";
import { renderReelStills } from "../../src/render-reel";
import type { ReelAsset } from "../../src/reel/types";
import { COMPARE_SIZE, compareFrames, fiveOf, formatResult, referencesIn, writeReferences, writeSheet, type FrameResult } from "../compare-frames";
import { readImage } from "./ffmpeg";
import { differenceMask, type Rgb, type Tolerance } from "./image";
import { judgeAttachment, measureAttachment, type AttachmentVerdict } from "./attachment";
import { fiveFrames, planeFromPath, type PlaneEvaluator } from "./placement";

/** Preview against export on the same machine: the encoder's loss only (calibrated on the smoke, see ADR 0053). */
export const PREVIEW_TOLERANCE: Tolerance = { minSsim: 0.9, maxBlock: 24 };
/** Against committed references, which may come from another machine's Chrome and fonts. */
export const BASELINE_TOLERANCE: Tolerance = { minSsim: 0.85, maxBlock: 40 };
/** How far (px, at 540 wide) a glyph may stray past its plane, and drift within it. */
export const ATTACH_TOLERANCE_PX = 4;
const STILL_WIDTH = 540;
const PROBE_COLOUR = "#ff00ff";

export type AcceptanceReport = {
  preview: FrameResult[];
  baseline: { mode: string; results: FrameResult[] };
  attachment: { textId: string; text: string; frames: number[]; verdict: AttachmentVerdict; control: AttachmentVerdict; detail: unknown[] }[];
  failures: string[];
};

export async function runAcceptance(input: {
  timeline: Timeline; assets: Record<string, ReelAsset>; video: string; outDir: string; baselineDir: string; fps?: number;
  baselineMode?: string; evaluate?: PlaneEvaluator; log?: (line: string) => void;
}): Promise<AcceptanceReport> {
  const { timeline, assets, video, outDir } = input;
  const fps = input.fps ?? 30;
  const log = input.log ?? console.log;
  const evaluate = input.evaluate ?? planeFromPath;
  const failures: string[] = [];
  await mkdir(outDir, { recursive: true });
  const plan = framePlan(timeline, fps);
  const rows = plan.clips.map(({ from, durationInFrames }) => fiveOf(from, from + durationInFrames));
  const planar = timeline.texts.filter((text) => text.pin?.quad || text.surface);
  const attachFrames = new Map(planar.map((text) => [text.id, fiveFrames(timeline, text, fps, evaluate)]));

  // Every still the checks need, drawn once.
  const stillsDir = path.join(outDir, "stills");
  await mkdir(stillsDir, { recursive: true });
  const wanted = [...new Set([...rows.flat(), ...[...attachFrames.values()].flat()])].sort((a, b) => a - b);
  log(`acceptance: drawing ${wanted.length} stills`);
  const stills = await renderReelStills({ timeline, assets, frames: wanted, dir: stillsDir, width: STILL_WIDTH });

  // 1. Preview matches export.
  const preview = await compareFrames(video, rows.flat(), async (frame) => (stills.has(frame) ? readImage(stills.get(frame)!, COMPARE_SIZE) : null), PREVIEW_TOLERANCE);
  log(`acceptance: preview against export (ssim ≥ ${PREVIEW_TOLERANCE.minSsim}, worst block ≤ ${PREVIEW_TOLERANCE.maxBlock})`);
  for (const result of preview.results) log(formatResult(result));
  for (const result of preview.results.filter((r) => !r.ok)) failures.push(`preview and export differ at frame ${result.frame}${result.score ? ` (ssim ${result.score.ssim.toFixed(3)}, worst block ${result.score.worstBlock.toFixed(1)})` : `: ${result.note}`}`);
  await writeSheet(rows, preview.decoded, path.join(outDir, "export-sheet.png"));
  const previewImages = new Map<number, Rgb>();
  for (const frame of rows.flat()) if (stills.has(frame)) previewImages.set(frame, await readImage(stills.get(frame)!, COMPARE_SIZE));
  await writeSheet(rows, previewImages, path.join(outDir, "preview-sheet.png"));

  // 2. Baseline.
  const mode = input.baselineMode ?? "report";
  let baseline: FrameResult[] = [];
  if (mode === "update") {
    await writeReferences(preview.decoded, input.baselineDir);
    log(`acceptance: wrote ${preview.decoded.size} baseline references to ${input.baselineDir}`);
  } else {
    baseline = (await compareFrames(video, rows.flat(), referencesIn(input.baselineDir), BASELINE_TOLERANCE)).results;
    log(`acceptance: export against baseline (${mode}; ssim ≥ ${BASELINE_TOLERANCE.minSsim}, worst block ≤ ${BASELINE_TOLERANCE.maxBlock})`);
    for (const result of baseline) log(formatResult(result));
    if (mode === "strict") for (const result of baseline.filter((r) => !r.ok)) failures.push(`export differs from the baseline at frame ${result.frame}`);
  }

  // 3. Motion attachment.
  const attachment: AcceptanceReport["attachment"] = [];
  for (const text of planar) {
    const frames = attachFrames.get(text.id) ?? [];
    if (!frames.length) continue;
    // The title's pixels: the frame with a probe of it, less the frame without it. The probe is the same title
    // in solid magenta with no surface blend or shadow, so its letters stand out on any footage (white letters
    // hard-lit onto a white window or a pale wall drew almost nothing to measure). Colour, blend and shadow do
    // not enter the placement code, so the probe sits exactly where the title does.
    const probe: Timeline = { ...timeline, texts: timeline.texts.map((other) => (other.id === text.id ? { ...other, color: PROBE_COLOUR, blend: undefined, shadow: "none" as const } : other)) };
    const without: Timeline = { ...timeline, texts: timeline.texts.filter((other) => other.id !== text.id) };
    const probeDir = path.join(outDir, `probe-${text.id}`), bareDir = path.join(outDir, `without-${text.id}`);
    await mkdir(probeDir, { recursive: true });
    await mkdir(bareDir, { recursive: true });
    const probed = await renderReelStills({ timeline: probe, assets, frames, dir: probeDir, width: STILL_WIDTH });
    const bare = await renderReelStills({ timeline: without, assets, frames, dir: bareDir, width: STILL_WIDTH });
    const measured = [];
    const controls = [];
    for (const [index, frame] of frames.entries()) {
      const plane = evaluate(timeline, text, frame, fps)!;
      const a = await readImage(probed.get(frame)!), b = await readImage(bare.get(frame)!);
      const mask = differenceMask(a, b, 40);
      const base = { frame, mask, width: a.width, height: a.height, base: plane.base, clipped: plane.clipped, tolerancePx: ATTACH_TOLERANCE_PX };
      const flags = { expectVisible: plane.opacity >= 0.15, fullStrength: plane.opacity >= 0.9, clipped: plane.clipped };
      measured.push({ ...measureAttachment({ ...base, quad: plane.quad }), ...flags });
      // The control: the same glyphs against a plane that slides 1.5% of the frame further each frame (the
      // title staying put while its surface moves on) must fail, or the check cannot see a title walk off.
      const moved = plane.quad.map((v, i) => v + index * (i % 2 === 0 ? 0.015 : 0.01));
      controls.push({ ...measureAttachment({ ...base, quad: moved }), ...flags });
    }
    const verdict = judgeAttachment(measured, ATTACH_TOLERANCE_PX);
    const control = judgeAttachment(controls, ATTACH_TOLERANCE_PX);
    const label = JSON.stringify(text.text.replace(/\n/g, " "));
    log(`acceptance: ${label} (${text.id}) on its plane at frames ${frames.join(", ")}: ${verdict.ok ? "ok" : "FAIL"}, drift ${verdict.drift.toFixed(1)} px (control: ${control.ok ? "passed, which it must not" : `caught, drift ${control.drift.toFixed(1)} px`})`);
    for (const m of measured) log(`    frame ${String(m.frame).padStart(4)}  ${m.glyphs} glyph px, ${m.outside} off the plane, in-plane box ${m.box ? `${m.box.left.toFixed(0)}–${m.box.right.toFixed(0)} × ${m.box.top.toFixed(0)}–${m.box.bottom.toFixed(0)} of ${m.plane.width.toFixed(0)}×${m.plane.height.toFixed(0)}` : "none"}${m.expectVisible ? "" : " (faded out)"}`);
    for (const problem of verdict.problems) { log(`    ${problem}`); failures.push(`${label}: ${problem}`); }
    if (control.ok && measured.some((m) => m.box)) failures.push(`${label}: the control (a plane sliding away under the title) passed too, so the check cannot see a title leave its plane`);
    attachment.push({ textId: text.id, text: text.text, frames, verdict, control, detail: measured.map(({ frame, glyphs, outside, box, plane, screen }) => ({ frame, glyphs, outside, box, plane, screen })) });
    // The title as drawn, and the probe it was measured by, one row each.
    const sheet = new Map<number, Rgb>();
    for (const f of frames) { sheet.set(f, await readImage(stills.get(f)!)); sheet.set(-1 - f, await readImage(probed.get(f)!)); }
    await writeSheet([frames, frames.map((f) => -1 - f)], sheet, path.join(outDir, `attach-${text.id}.png`));
  }

  const report: AcceptanceReport = { preview: preview.results, baseline: { mode, results: baseline }, attachment, failures };
  await writeFile(path.join(outDir, "acceptance.json"), JSON.stringify(report, null, 2));
  return report;
}
