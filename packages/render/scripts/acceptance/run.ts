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
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { framePlan, type Timeline } from "@reelwalk/core";
import { renderReelStills } from "../../src/render-reel";
import type { ReelAsset } from "../../src/reel/types";
import { COMPARE_SIZE, compareFrames, fiveOf, formatResult, referencesIn, writeReferences, writeSheet, type FrameResult } from "../compare-frames";
import { extractFrames, readImage, writePng } from "./ffmpeg";
import { differenceMask, regionChange, type Rgb, type Tolerance } from "./image";
import { erode, judgeAttachment, judgeShape, measureAttachment, mirroredCorners, rectifyMask, type AttachmentVerdict, type Rectified, type ShapeVerdict } from "./attachment";
import { fiveFrames, planeFromPath, type PlaneEvaluator } from "./placement";

/** Preview against export on the same machine: the encoder's loss only (calibrated on the smoke, see ADR 0053). */
export const PREVIEW_TOLERANCE: Tolerance = { minSsim: 0.9, maxBlock: 24 };
/** Against committed references, which may come from another machine's Chrome and fonts. */
export const BASELINE_TOLERANCE: Tolerance = { minSsim: 0.85, maxBlock: 40 };
/** How far (px, at 540 wide) a glyph may stray past its plane, and drift within it. */
export const ATTACH_TOLERANCE_PX = 4;
const STILL_WIDTH = 540;
const PROBE_COLOUR = "#ff00ff";
/**
 * Over a title's letters, the largest fraction whose luma may differ (by more than 32) between the export and
 * the still with the title. Calibrated on the smoke: 0.0 to 3.5% with the title, 21 to 99% without it ("BY THE
 * FIRE", white on a bright window, is the hardest at 21%).
 */
export const TITLE_REGION_LIMIT = 0.1;

type ShapeFrame = { frame: number; rectified: Rectified; fullStrength: boolean; glyphs: number };
type RegionResult = { frame: number; present: number; absent: number };

async function writeMask(mask: Rectified, file: string): Promise<void> {
  const data = new Uint8Array(mask.cols * mask.rows * 3);
  mask.data.forEach((v, i) => { if (v) data.fill(255, i * 3, i * 3 + 3); });
  await writePng({ width: mask.cols, height: mask.rows, data }, file);
}

/** A reference mask, or null when it was made for a plane of another size (the fixture changed: update it). */
async function readMask(file: string, like: Rectified | undefined): Promise<Rectified | null> {
  const image = await readImage(file);
  if (like && (image.width !== like.cols || image.height !== like.rows)) return null;
  const data = new Uint8Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) data[i] = image.data[i * 3] > 127 ? 1 : 0;
  return { cols: image.width, rows: image.height, data };
}

export type AcceptanceReport = {
  preview: FrameResult[];
  baseline: { mode: string; results: FrameResult[] };
  attachment: { textId: string; text: string; frames: number[]; verdict: AttachmentVerdict; control: AttachmentVerdict; shape: ShapeVerdict; region: RegionResult[]; detail: unknown[] }[];
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
  // A callout (ADR 0061) pins a point, not a plane to paint on: its label is a screen title.
  const planar = timeline.texts.filter((text) => (text.pin?.quad || text.surface) && !text.callout);
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

  // 3. Each planar title: on its plane (attachment), the right shape on it, and present in the export.
  const attachment: AcceptanceReport["attachment"] = [];
  const exported = await extractFrames(video, [...new Set([...attachFrames.values()].flat())], { width: STILL_WIDTH, height: Math.round((STILL_WIDTH * 16) / 9) });
  for (const text of planar) {
    const label = JSON.stringify(text.text.replace(/\n/g, " "));
    const frames = attachFrames.get(text.id) ?? [];
    if (!frames.length) { failures.push(`${label}: no frame of the reel has the title on a plane, so nothing about it could be checked`); continue; }
    // The title's pixels: the frame with a probe of it, less the frame without it. The probe is the same title
    // in solid magenta with no surface blend or shadow, so its letters stand out on any footage (white letters
    // hard-lit onto a white window or a pale wall drew almost nothing to measure). Colour, blend and shadow do
    // not enter the placement code, so the probe sits exactly where the title does. Its particles (ADR 0055) are left out: they are not glyphs.
    // Its shine (ADR 0061) stays: the band is drawn in the plane, clipped to the glyphs, so the probe checks that the
    // light's copies of the letters land on the letters. Its kinetic move is left out: a slide or a word still arriving
    // is not where the letters rest on the plane.
    const probe: Timeline = { ...timeline, texts: timeline.texts.map((other) => (other.id === text.id ? { ...other, color: PROBE_COLOUR, blend: undefined, shadow: "none" as const, particles: undefined, kinetic: undefined } : other)) };
    const without: Timeline = { ...timeline, texts: timeline.texts.filter((other) => other.id !== text.id) };
    const probeDir = path.join(outDir, `probe-${text.id}`), bareDir = path.join(outDir, `without-${text.id}`);
    await mkdir(probeDir, { recursive: true });
    await mkdir(bareDir, { recursive: true });
    const probed = await renderReelStills({ timeline: probe, assets, frames, dir: probeDir, width: STILL_WIDTH });
    const bare = await renderReelStills({ timeline: without, assets, frames, dir: bareDir, width: STILL_WIDTH });
    const measured = [], sliding = [];
    const shapes: ShapeFrame[] = [], mirrored: ShapeFrame[] = [], thinned: ShapeFrame[] = [];
    const region: RegionResult[] = [];
    for (const [index, frame] of frames.entries()) {
      const plane = evaluate(timeline, text, frame, fps)!;
      const a = await readImage(probed.get(frame)!), b = await readImage(bare.get(frame)!);
      const mask = differenceMask(a, b, 40);
      const base = { frame, mask, width: a.width, height: a.height, base: plane.base, clipped: plane.clipped, tolerancePx: ATTACH_TOLERANCE_PX };
      const flags = { expectVisible: plane.opacity >= 0.15, fullStrength: plane.opacity >= 0.9, clipped: plane.clipped };
      const m = { ...measureAttachment({ ...base, quad: plane.quad }), ...flags };
      measured.push(m);
      // Control: the same glyphs against a plane that slides 1.5% of the frame further each frame (the title
      // staying put while its surface moves on) must fail, or the check cannot see a title walk off.
      const moved = plane.quad.map((v, i) => v + index * (i % 2 === 0 ? 0.015 : 0.01));
      sliding.push({ ...measureAttachment({ ...base, quad: moved }), ...flags });
      // The letters in the plane's own rectangle, and the two shape controls: the plane's corners in mirrored
      // order (a title placed from a mirrored drag), and the letters a pixel thinner all round.
      const rectify = (q: readonly number[], k: Uint8Array) => rectifyMask({ mask: k, width: a.width, height: a.height, quad: q, base: plane.base, clipped: plane.clipped });
      shapes.push({ frame, rectified: rectify(plane.quad, mask), fullStrength: flags.fullStrength, glyphs: m.glyphs });
      mirrored.push({ frame, rectified: rectify(mirroredCorners(plane.quad), mask), fullStrength: flags.fullStrength, glyphs: m.glyphs });
      thinned.push({ frame, rectified: rectify(plane.quad, erode(mask, a.width, a.height)), fullStrength: flags.fullStrength, glyphs: m.glyphs });
      // Present in the export: over the title's own letters (the inside of the probe's mask), the export
      // must match the still with the title and must not match the still without it.
      if (flags.expectVisible && m.glyphs > 0) {
        const inner = erode(mask, a.width, a.height);
        const letters = inner.reduce((n, v) => n + v, 0) >= 50 ? inner : mask;
        const exportFrame = exported.get(frame);
        if (!exportFrame) { failures.push(`${label}: the export has no frame ${frame}`); continue; }
        const still = await readImage(stills.get(frame)!);
        const present = regionChange(exportFrame, still, letters), absent = regionChange(exportFrame, b, letters);
        region.push({ frame, present, absent });
        if (present > TITLE_REGION_LIMIT) failures.push(`${label}: at frame ${frame} the export differs from the still over the title's letters (${(present * 100).toFixed(1)}% of them, limit ${TITLE_REGION_LIMIT * 100}%)`);
        if (absent <= TITLE_REGION_LIMIT) failures.push(`${label}: at frame ${frame} the export also matches the still without the title (${(absent * 100).toFixed(1)}% of its letters differ), so a missing title would pass`);
      }
    }
    const verdict = judgeAttachment(measured, ATTACH_TOLERANCE_PX);
    const control = judgeAttachment(sliding, ATTACH_TOLERANCE_PX);
    // The approved shape: a reference rectified mask per title, kept with the baseline references.
    const refFile = path.join(input.baselineDir, `rectified-${text.id}.png`);
    const firstFull = shapes.find((f) => f.fullStrength && f.glyphs > 0);
    if (mode === "update" && firstFull) await writeMask(firstFull.rectified, refFile);
    const reference = existsSync(refFile) ? await readMask(refFile, firstFull?.rectified) : null;
    const shape = judgeShape(shapes, reference, mode === "strict");
    const mirrorControl = judgeShape(mirrored, reference, false), thinControl = judgeShape(thinned, reference, false);
    log(`acceptance: ${label} (${text.id}) at frames ${frames.join(", ")}: on its plane ${verdict.ok ? "ok" : "FAIL"} (drift ${verdict.drift.toFixed(1)} px; sliding control ${control.ok ? "PASSED, which it must not" : `caught, ${control.drift.toFixed(1)} px`})`);
    for (const m of measured) log(`    frame ${String(m.frame).padStart(4)}  ${m.glyphs} glyph px, ${m.outside} off the plane, in-plane box ${m.box ? `${m.box.left.toFixed(0)}–${m.box.right.toFixed(0)} × ${m.box.top.toFixed(0)}–${m.box.bottom.toFixed(0)} of ${m.plane.width.toFixed(0)}×${m.plane.height.toFixed(0)}` : "none"}${m.expectVisible ? "" : " (faded out)"}`);
    const fmt = (d: Record<string, number>) => Object.entries(d).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ");
    log(`    shape ${shape.ok ? "ok" : "FAIL"} (${fmt(shape.detail)}); mirrored control ${mirrorControl.ok ? "PASSED, which it must not" : "caught"}; thinned control ${thinControl.ok ? "PASSED, which it must not" : "caught"}`);
    log(`    in the export: ${region.map((r) => `frame ${r.frame} ${(r.present * 100).toFixed(1)}% differ (without the title ${(r.absent * 100).toFixed(1)}%)`).join("; ") || "no visible frame"}`);
    for (const problem of [...verdict.problems, ...shape.problems]) { log(`    ${problem}`); failures.push(`${label}: ${problem}`); }
    if (control.ok && measured.some((m) => m.box)) failures.push(`${label}: the sliding control passed, so the check cannot see a title leave its plane`);
    if (mirrorControl.ok) failures.push(`${label}: the mirrored-corner control passed, so the check cannot see a mirrored title`);
    if (thinControl.ok) failures.push(`${label}: the thinned control passed, so the check cannot see thinner letters`);
    if (!region.length) failures.push(`${label}: no frame where the title should be visible drew it, so its presence in the export was not checked`);
    attachment.push({ textId: text.id, text: text.text, frames, verdict, control, shape, region, detail: measured.map(({ frame, glyphs, outside, box, plane, screen }) => ({ frame, glyphs, outside, box, plane, screen })) });
    // The title as drawn, and the probe it was measured by, one row each.
    const sheet = new Map<number, Rgb>();
    for (const f of frames) { sheet.set(f, await readImage(stills.get(f)!)); sheet.set(-1 - f, await readImage(probed.get(f)!)); }
    await writeSheet([frames, frames.map((f) => -1 - f)], sheet, path.join(outDir, `attach-${text.id}.png`));
  }

  const report: AcceptanceReport = { preview: preview.results, baseline: { mode, results: baseline }, attachment, failures };
  await writeFile(path.join(outDir, "acceptance.json"), JSON.stringify(report, null, 2));
  return report;
}
