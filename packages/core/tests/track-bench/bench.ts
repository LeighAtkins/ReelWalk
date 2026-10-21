/**
 * The ADR 0052 benchmark: corner error and false confidence for the legacy
 * tracker and the new pipeline on the synthetic set. Both outputs are passed
 * through smoothing the way the editor stores them.
 *
 * - corner error: mean distance of the four corners from the truth, px at the
 *   benchmark size, over the frames the tracker shows at full opacity;
 * - a frame is "confident" when the tracker presents it as attached: legacy,
 *   full opacity and an overall grade of "good" (the only per-track signal it
 *   had); new, per-frame confidence ≥ 0.5 on a track that was not rejected;
 * - false confidence: confident frames whose corner error exceeds `wrongPx`
 *   (3 px at 360 wide ≈ 9 output px), over all frames.
 */
import { smoothKeyframes, smoothLive, trackSurface, type Quad } from "../../src";
import { legacyTrack } from "./legacy";
import { cornerError, type Scenario } from "./synth";

export type Row = {
  scenario: string; tracker: "legacy" | "new"; outcome: string;
  /** Frames shown at full opacity (excluding frame 0). */
  shown: number; meanErr: number | null; maxErr: number | null;
  confident: number; falseConfident: number;
  /** Frames shown at full opacity whose corners are more than `wrongPx` off, whatever the tracker claimed. */
  shownWrong: number;
  frames: number;
};

/** As the editor stores them: legacy smoothed the whole path; the new pipeline smooths each live run (`smoothLive`). */
function smoothed(quads: Quad[], live?: boolean[]): Quad[] {
  const path = quads.map((q, i) => ({ t: i / Math.max(1, quads.length - 1), x: 0, y: 0, q: [...q] }));
  return (live ? smoothLive(path, live) : smoothKeyframes(path)).map((p) => p.q as Quad);
}

function row(scenario: Scenario, tracker: Row["tracker"], outcome: string, quads: Quad[] | null, shown: boolean[], confident: boolean[], wrongPx: number): Row {
  const n = scenario.frames.length - 1;
  if (!quads) return { scenario: scenario.name, tracker, outcome, shown: 0, meanErr: null, maxErr: null, confident: 0, falseConfident: 0, shownWrong: 0, frames: n };
  const errs = quads.map((q, i) => cornerError(q, scenario.truth[i]));
  // Frames after a cut have no right answer (truth is infinite): they count against confidence but not the mean.
  const shownErrs = errs.flatMap((e, i) => (i > 0 && shown[i] && Number.isFinite(e) ? [e] : []));
  const conf = errs.flatMap((e, i) => (i > 0 && confident[i] ? [e] : []));
  return {
    scenario: scenario.name, tracker, outcome, shown: errs.filter((_, i) => i > 0 && shown[i]).length,
    meanErr: shownErrs.length ? shownErrs.reduce((s, e) => s + e, 0) / shownErrs.length : null,
    maxErr: shownErrs.length ? Math.max(...shownErrs) : null,
    confident: conf.length, falseConfident: conf.filter((e) => e > wrongPx).length,
    shownWrong: errs.filter((e, i) => i > 0 && shown[i] && e > wrongPx).length, frames: n,
  };
}

export function benchmark(set: Scenario[], wrongPx = 3 * (set[0].frames[0].width / 360)): Row[] {
  const rows: Row[] = [];
  for (const sc of set) {
    const legacy = legacyTrack(sc.frames, sc.quad);
    if (!legacy) rows.push(row(sc, "legacy", "refused", null, [], [], wrongPx));
    else {
      const quads = smoothed(legacy.frames.map((f) => f.quad));
      const shown = legacy.frames.map((f) => f.o >= 1);
      rows.push(row(sc, "legacy", legacy.grade + (legacy.lostAt !== null ? ` @${legacy.lostAt}` : ""), quads, shown, shown.map((s) => s && legacy.grade === "good"), wrongPx));
    }
    const fresh = trackSurface(sc.frames, [{ index: 0, quad: sc.quad }]);
    if (!fresh.ok) rows.push(row(sc, "new", `refused: ${fresh.reason} @${fresh.frame}`, null, [], [], wrongPx));
    else {
      const quads = smoothed(fresh.frames.map((f) => f.quad), fresh.frames.map((f) => !f.lost));
      const shown = fresh.frames.map((f) => !f.lost);
      rows.push(row(sc, "new", fresh.lostAt !== null ? `lost @${fresh.lostAt} (${fresh.lostReason})` : "tracked", quads, shown, fresh.frames.map((f) => !f.lost && f.confidence >= 0.5), wrongPx));
    }
  }
  return rows;
}

export function table(rows: Row[]): string {
  const f = (v: number | null) => (v === null ? "–" : v.toFixed(2));
  const lines = ["| scenario | tracker | outcome | shown | mean err px | max err px | confident | false-confident | shown wrong |", "|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.scenario} | ${r.tracker} | ${r.outcome} | ${r.shown}/${r.frames} | ${f(r.meanErr)} | ${f(r.maxErr)} | ${r.confident} | ${r.falseConfident} | ${r.shownWrong} |`);
  for (const tracker of ["legacy", "new"] as const) {
    const mine = rows.filter((r) => r.tracker === tracker);
    const shownWrong = mine.reduce((s, r) => s + r.shownWrong, 0);
    const frames = mine.reduce((s, r) => s + r.frames, 0), confident = mine.reduce((s, r) => s + r.confident, 0), wrong = mine.reduce((s, r) => s + r.falseConfident, 0);
    const tracked = mine.filter((r) => r.meanErr !== null && r.scenario !== "blank wall");
    const meanErr = tracked.length ? tracked.reduce((s, r) => s + r.meanErr!, 0) / tracked.length : null;
    lines.push(`| **all** | ${tracker} | | | ${f(meanErr)} (textured, mean of scenarios) | | ${confident}/${frames} | ${wrong}/${frames} (${((100 * wrong) / Math.max(1, frames)).toFixed(1)}%; ${((100 * wrong) / Math.max(1, confident)).toFixed(1)}% of confident) | ${shownWrong}/${frames} |`);
  }
  return lines.join("\n");
}
