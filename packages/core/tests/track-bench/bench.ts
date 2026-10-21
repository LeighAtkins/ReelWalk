/**
 * The ADR 0052 benchmark: corner error and false confidence for the legacy
 * tracker and the new pipeline on the synthetic set, measured on the path
 * each one saves, not on the raw tracker output:
 *
 * - new: `smoothTrack` then `trackPath`, exactly as `trackTextPathDetailed`
 *   does, with keyframe corners read back from the saved `q` fractions and
 *   opacity from `o`;
 * - legacy: its keyframes with its `o` fade, through `smoothKeyframes` over
 *   the whole path, as main stores them.
 *
 * Every keyframe drawn at all (o > 0) counts, partially transparent ones
 * included:
 * - corner error: mean distance of the four corners from the truth, px at the
 *   benchmark size, averaged with opacity as the weight;
 * - "confident": drawn and presented as attached (legacy: grade "good", the
 *   only signal it had; new: per-keyframe confidence ≥ 0.5);
 * - false confidence: confident keyframes whose error exceeds `wrongPx`
 *   (3 px at 360 wide ≈ 9 output px);
 * - shown wrong: drawn keyframes over `wrongPx`, whatever was claimed;
 * - jitter: frame-to-frame change of the corner error between consecutive
 *   drawn keyframes, mean over corners and pairs, px (shimmer a viewer sees
 *   that the surface does not have).
 * Frames after a cut have no right answer (infinite error).
 */
import { defaultTolerance, smoothKeyframes, smoothTrack, trackPath, trackSurface, type Quad } from "../../src";
import { legacyTrack } from "./legacy";
import { cornerError, type Scenario } from "./synth";

export type Row = {
  scenario: string; tracker: "legacy" | "new"; outcome: string;
  /** Keyframes drawn (o > 0), excluding the first. */
  shown: number; meanErr: number | null; maxErr: number | null;
  confident: number; falseConfident: number;
  shownWrong: number;
  jitter: number | null;
  frames: number;
};

type Saved = { quads: Quad[]; opacity: number[]; confident: boolean[] };

function row(scenario: Scenario, tracker: Row["tracker"], outcome: string, saved: Saved | null, wrongPx: number): Row {
  const n = scenario.frames.length - 1;
  if (!saved) return { scenario: scenario.name, tracker, outcome, shown: 0, meanErr: null, maxErr: null, confident: 0, falseConfident: 0, shownWrong: 0, jitter: null, frames: n };
  const errs = saved.quads.map((q, i) => cornerError(q, scenario.truth[i]));
  const drawn = errs.flatMap((e, i) => (i > 0 && saved.opacity[i] > 0 ? [{ e, o: saved.opacity[i], i }] : []));
  const finite = drawn.filter((d) => Number.isFinite(d.e));
  const weight = finite.reduce((s, d) => s + d.o, 0);
  const steps: number[] = [];
  for (let i = 1; i < saved.quads.length; i++) {
    if (saved.opacity[i] <= 0 || saved.opacity[i - 1] <= 0 || !Number.isFinite(errs[i]) || !Number.isFinite(errs[i - 1])) continue;
    let sum = 0;
    for (let c = 0; c < 4; c++) {
      const ex = saved.quads[i][c * 2] - scenario.truth[i][c * 2] - (saved.quads[i - 1][c * 2] - scenario.truth[i - 1][c * 2]);
      const ey = saved.quads[i][c * 2 + 1] - scenario.truth[i][c * 2 + 1] - (saved.quads[i - 1][c * 2 + 1] - scenario.truth[i - 1][c * 2 + 1]);
      sum += Math.hypot(ex, ey);
    }
    steps.push(sum / 4);
  }
  return {
    scenario: scenario.name, tracker, outcome, shown: drawn.length,
    jitter: steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : null,
    meanErr: weight ? finite.reduce((s, d) => s + d.o * d.e, 0) / weight : null,
    maxErr: finite.length ? Math.max(...finite.map((d) => d.e)) : null,
    confident: drawn.filter((d) => saved.confident[d.i]).length,
    falseConfident: drawn.filter((d) => saved.confident[d.i] && d.e > wrongPx).length,
    shownWrong: drawn.filter((d) => d.e > wrongPx).length, frames: n,
  };
}

const toPx = (q: number[], width: number, height: number) => q.map((v, i) => (i % 2 === 0 ? v * width : v * height)) as Quad;

/** The new pipeline's saved path for a scenario, sampled every 100 ms. */
export function savedNew(sc: Scenario): { saved: Saved | null; outcome: string } {
  const { width, height } = sc.frames[0];
  const result = trackSurface(sc.frames, [{ index: 0, quad: sc.quad }]);
  if (!result.ok) return { saved: null, outcome: `refused: ${result.reason} @${result.frame}` };
  const times = sc.frames.map((_, i) => i * 100);
  const { path, confidence } = trackPath(smoothTrack(result.frames, { floorPx: defaultTolerance(width) }), times, { fromMs: 0, toMs: times[times.length - 1] }, { x: 0.5, y: 0.42 }, { width, height });
  if (path.length !== sc.frames.length) throw new Error("expected one keyframe per frame");
  const reacquired = result.frames.findIndex((f, i) => i > (result.lostAt ?? Infinity) && !f.lost);
  return {
    saved: { quads: path.map((p) => toPx(p.q, width, height)), opacity: path.map((p) => p.o ?? 1), confident: confidence.map((c) => c >= 0.5) },
    outcome: result.lostAt !== null ? `lost @${result.lostAt} (${result.lostReason})${reacquired > 0 ? `, found again @${reacquired}` : ""}` : "tracked",
  };
}

export function benchmark(set: Scenario[], wrongPx = 3 * (set[0].frames[0].width / 360)): Row[] {
  const rows: Row[] = [];
  for (const sc of set) {
    const { width, height } = sc.frames[0];
    const legacy = legacyTrack(sc.frames, sc.quad);
    if (!legacy) rows.push(row(sc, "legacy", "refused", null, wrongPx));
    else {
      const path = legacy.frames.map((f, i) => ({ t: i / (legacy.frames.length - 1), x: 0, y: 0, q: f.quad.map((v, k) => (k % 2 === 0 ? v / width : v / height)), ...(f.o < 1 ? { o: f.o } : {}) }));
      const smooth = smoothKeyframes(path);
      rows.push(row(sc, "legacy", legacy.grade + (legacy.lostAt !== null ? ` @${legacy.lostAt}` : ""), {
        quads: smooth.map((p) => toPx(p.q, width, height)), opacity: smooth.map((p) => p.o ?? 1), confident: smooth.map(() => legacy.grade === "good"),
      }, wrongPx));
    }
    const fresh = savedNew(sc);
    rows.push(row(sc, "new", fresh.outcome, fresh.saved, wrongPx));
  }
  return rows;
}

export function totals(rows: Row[], tracker: Row["tracker"]) {
  const mine = rows.filter((r) => r.tracker === tracker);
  const tracked = mine.filter((r) => r.meanErr !== null && r.scenario !== "blank wall");
  return {
    frames: mine.reduce((s, r) => s + r.frames, 0), confident: mine.reduce((s, r) => s + r.confident, 0),
    falseConfident: mine.reduce((s, r) => s + r.falseConfident, 0), shownWrong: mine.reduce((s, r) => s + r.shownWrong, 0),
    meanErr: tracked.length ? tracked.reduce((s, r) => s + r.meanErr!, 0) / tracked.length : null,
  };
}

export function table(rows: Row[]): string {
  const f = (v: number | null) => (v === null ? "–" : v.toFixed(2));
  const lines = ["| scenario | tracker | outcome | drawn | mean err px (opacity-weighted) | max err px | jitter px | confident | false-confident | shown wrong |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.scenario} | ${r.tracker} | ${r.outcome} | ${r.shown}/${r.frames} | ${f(r.meanErr)} | ${f(r.maxErr)} | ${f(r.jitter)} | ${r.confident} | ${r.falseConfident} | ${r.shownWrong} |`);
  for (const tracker of ["legacy", "new"] as const) {
    const t = totals(rows, tracker);
    lines.push(`| **all** | ${tracker} | | | ${f(t.meanErr)} (textured, mean of scenarios) | | | ${t.confident}/${t.frames} | ${t.falseConfident}/${t.frames} (${((100 * t.falseConfident) / Math.max(1, t.frames)).toFixed(1)}%) | ${t.shownWrong}/${t.frames} |`);
  }
  return lines.join("\n");
}
