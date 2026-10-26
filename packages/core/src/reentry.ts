/**
 * Where a song comes back (ADR 0090, gap #6 of the reference study): the moment a reveal shot should start on.
 *
 * Reel 5 of the owner's references (DZThJZ5Sa3Z) holds its biggest picture, the house lit up at dusk from above, for the
 * music's return: the track falls away (-30 to -44 dBFS inside 0.2 s at 27.8 s), an empty sunset plays in the near
 * silence, and the cut lands on the rise, as the chorus builds. This finds that shape in a song's stored
 * energy curve (ADR 0059's analysis: loudness per 100 ms, 0 the quietest step to 1 the loudest): a stop at least a
 * second long, well below the song's loud level, followed by a return to it. When the song has no stop it falls back
 * to the biggest section change (into a drop, ADR 0059), then to the analysis's own drop, and says which it found.
 *
 * Pure: the song's analysis in, song times out.
 */
import type { SongSection } from "./timeline";

export type Reentry = {
  /** "break": a real stop then a return; "section": the biggest step into a drop; "drop": the analysis's first drop. */
  kind: "break" | "section" | "drop";
  /** Song time (ms) the music comes back: the reveal's cut goes here (snapped to the beat by the planner). */
  atMs: number;
  /** For a break: when the music fell away, song ms. */
  breakFromMs?: number;
  /** How far it fell, in energy units (0..1 of the song's loudness range), and how long it stayed down. */
  depth?: number;
  quietMs?: number;
};

export const REENTRY = {
  /** A break lasts at least this long… */
  minQuietMs: 1500,
  /** …with its loudness, averaged over a second (so a breakdown's sparse stabs do not split it), this far below the loud level. */
  minDepth: 0.1,
  /** The window of that average, and of the before/after comparison that finds the return. */
  smoothMs: 1000,
  /** The return is looked for from half a second before the break ends to this long after. */
  recoverMs: 2500,
  /** And must bring the music back up by at least this much (the half second after against the half second before). */
  minRise: 0.05,
  /** The windows that place the return, ms: short, so a hard hit is found on its own step rather than smeared. */
  riseMs: 500,
  /** Hits inside a breakdown up to this long do not end it. */
  maxHitMs: 1500,
} as const;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))] ?? 0;
}

function meanOf(values: readonly number[], from: number, to: number): number | null {
  const a = Math.max(0, from), b = Math.min(values.length, to);
  if (b <= a) return null;
  let sum = 0;
  for (let i = a; i < b; i++) sum += values[i];
  return sum / (b - a);
}

/**
 * The step in `[from, to)` where the music comes back hardest: the largest rise of the next half second's mean over the
 * last half second's. Null when nothing there rises by REENTRY.minRise.
 */
export function steepestRise(energy: readonly number[], stepMs: number, from: number, to: number): { at: number; rise: number } | null {
  const w = Math.max(1, Math.round(REENTRY.riseMs / stepMs));
  let best: { at: number; rise: number } | null = null;
  for (let i = Math.max(w, from); i < Math.min(energy.length - w, to); i++) {
    const before = meanOf(energy, i - w, i), after = meanOf(energy, i, i + w);
    if (before == null || after == null) continue;
    const rise = after - before;
    if (rise >= REENTRY.minRise && (!best || rise > best.rise + 1e-9)) best = { at: i, rise };
  }
  return best;
}

/**
 * The song's breaks with a return, best first: a stretch at least 1.5 s long whose one-second average sits clearly below
 * the song's loud level, after loud music (not a quiet intro), followed by the music coming back. `energy` is the
 * analysis's curve, `stepMs` its step. The return is the steepest rise near the break's end. The search skips the first
 * and last two seconds and anything outside `[fromMs, toMs]` when given (the part of the song a reel can use).
 */
export function findBreaks(energy: readonly number[], stepMs: number, range: { fromMs?: number; toMs?: number } = {}): Reentry[] {
  if (energy.length < 10) return [];
  const loud = percentile(energy, 75);
  const half = Math.max(1, Math.round(REENTRY.smoothMs / stepMs / 2));
  const smooth = energy.map((_, i) => meanOf(energy, i - half, i + half) ?? 0);
  const quietBelow = loud - REENTRY.minDepth;
  const first = Math.max(Math.ceil(2000 / stepMs), Math.ceil((range.fromMs ?? 0) / stepMs));
  const last = Math.min(energy.length - Math.ceil(2000 / stepMs), Math.floor((range.toMs ?? Infinity) / stepMs));
  const found: (Reentry & { score: number })[] = [];
  const two = Math.ceil(2000 / stepMs);
  let i = first;
  while (i < last) {
    if (smooth[i] > quietBelow) { i++; continue; }
    // A stop, not a quiet intro: the music was playing at its loud level in the two seconds before it fell away.
    const lead = meanOf(smooth, i - two, i);
    // A breakdown keeps hitting now and then: rises of up to 1.5 s inside it are part of the break.
    let j = i;
    for (;;) {
      while (j < energy.length && smooth[j] <= quietBelow) j++;
      let next = j;
      while (next < Math.min(last, j + Math.ceil(REENTRY.maxHitMs / stepMs)) && smooth[next] > quietBelow) next++;
      if (next >= last || next === j || smooth[next] > quietBelow) break;
      j = next;
    }
    const back = steepestRise(energy, stepMs, j - Math.round(500 / stepMs), j + Math.round(REENTRY.recoverMs / stepMs));
    // The return is sustained: the two seconds after it are above the quiet level.
    const after = back ? meanOf(energy, back.at, back.at + two) : null;
    const quietMs = (j - i) * stepMs;
    if (quietMs >= REENTRY.minQuietMs && back && after != null && after > quietBelow && lead != null && lead >= loud - REENTRY.minDepth / 2 && back.at <= last) {
      const depth = Math.round((loud - Math.min(...smooth.slice(i, j))) * 1000) / 1000;
      found.push({ kind: "break", atMs: back.at * stepMs, breakFromMs: i * stepMs, depth, quietMs, score: depth * Math.min(quietMs, 4000) });
    }
    i = j + 1;
  }
  return found.sort((a, b) => b.score - a.score).map((entry) => {
    const rest: Reentry & { score?: number } = { ...entry };
    delete rest.score;
    return rest;
  });
}

/** The biggest step into a drop among the song's sections (ADR 0059): the start of the drop after the quietest section before it. */
export function biggestSectionChange(sections: readonly SongSection[], energy: readonly number[], stepMs: number, range: { fromMs?: number; toMs?: number } = {}): Reentry | null {
  const level = (section: SongSection) => {
    const a = Math.floor(section.startMs / stepMs), b = Math.max(a + 1, Math.floor(section.endMs / stepMs));
    const slice = energy.slice(a, b);
    return slice.length ? slice.reduce((sum, value) => sum + value, 0) / slice.length : 0;
  };
  let best: { atMs: number; step: number } | null = null;
  for (let i = 1; i < sections.length; i++) {
    const into = sections[i];
    if (into.kind !== "drop" || sections[i - 1].kind === "drop") continue;
    if (range.fromMs != null && into.startMs < range.fromMs) continue;
    if (range.toMs != null && into.startMs > range.toMs) continue;
    const step = level(into) - level(sections[i - 1]);
    if (!best || step > best.step) best = { atMs: into.startMs, step };
  }
  if (!best) return null;
  // Sections start on bar lines counted from an estimated downbeat; the music's own return is the steepest rise near it.
  const near = Math.round(best.atMs / stepMs), reach = Math.round(2500 / stepMs);
  const rise = steepestRise(energy, stepMs, near - reach, near + reach);
  return { kind: "section", atMs: rise ? rise.at * stepMs : best.atMs, depth: Math.round(best.step * 1000) / 1000 };
}

/** The reveal's moment: a real break and return when the song has one, else the biggest section change, else its drop. Null when none. */
export function findReentry(
  analysis: { energy: { stepMs: number; values: readonly number[] }; sections?: readonly SongSection[]; drop?: { atMs: number } | null },
  range: { fromMs?: number; toMs?: number } = {},
): Reentry | null {
  const { stepMs, values } = analysis.energy;
  const breaks = findBreaks(values, stepMs, range);
  if (breaks.length) return breaks[0];
  const section = analysis.sections ? biggestSectionChange(analysis.sections, values, stepMs, range) : null;
  if (section) return section;
  const drop = analysis.drop;
  if (drop && (range.fromMs == null || drop.atMs >= range.fromMs) && (range.toMs == null || drop.atMs <= range.toMs)) return { kind: "drop", atMs: drop.atMs };
  return null;
}
