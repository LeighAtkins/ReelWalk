/**
 * Where a song comes back (ADR 0089, gap #6 of the reference study): the moment a reveal shot should start on.
 *
 * Reel 5 of the owner's references (DZThJZ5Sa3Z) holds its biggest picture, the house lit up at dusk from above, for the
 * music's return: the track falls away (-30 to -44 dBFS inside 0.2 s at 27.8 s), an empty sunset plays in the near
 * silence, and the cut lands 0.6 s into the rise, as the chorus builds. This finds that shape in a song's stored
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
  /** A stop is at least this long. */
  minQuietMs: 1000,
  /** And this far below the loud level, in energy units (about 12–15 dB on a 40–50 dB range). */
  minDepth: 0.3,
  /** The return must reach the loud level less this within this long after the stop ends. */
  recoverWithin: 0.15,
  recoverMs: 3000,
  /** The cut goes this far into the rise (the reference landed 0.6 s into it: "the first half of the rise"). */
  intoRise: 0.35,
} as const;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))] ?? 0;
}

/**
 * The song's breaks with a return, best first: a stop after loud music (not a quiet intro) (deepest × longest). `energy` is the analysis's curve, `stepMs` its step.
 * The search skips the first and last two seconds (a fade in or out is not a break) and anything outside
 * `[fromMs, toMs]` when given (the part of the song a reel can use).
 */
export function findBreaks(energy: readonly number[], stepMs: number, range: { fromMs?: number; toMs?: number } = {}): Reentry[] {
  if (energy.length < 10) return [];
  const loud = percentile(energy, 75);
  const quietBelow = loud - REENTRY.minDepth;
  const first = Math.max(Math.ceil(2000 / stepMs), Math.ceil((range.fromMs ?? 0) / stepMs));
  const last = Math.min(energy.length - Math.ceil(2000 / stepMs), Math.floor((range.toMs ?? Infinity) / stepMs));
  const found: (Reentry & { score: number })[] = [];
  let i = first;
  while (i < last) {
    if (energy[i] > quietBelow) { i++; continue; }
    let j = i;
    while (j < energy.length && energy[j] <= quietBelow) j++;
    const quietMs = (j - i) * stepMs;
    // The return: the first step after the stop within reach of the loud level.
    let back = -1;
    for (let k = j; k < Math.min(energy.length, j + Math.ceil(REENTRY.recoverMs / stepMs)); k++) {
      if (energy[k] >= loud - REENTRY.recoverWithin) { back = k; break; }
    }
    // A stop, not a quiet intro: the music was playing at its loud level in the two seconds before it fell away.
    const lead = energy.slice(Math.max(0, i - Math.ceil(2000 / stepMs)), i);
    const wasLoud = lead.length > 0 && lead.reduce((sum, value) => sum + value, 0) / lead.length >= loud - REENTRY.recoverWithin;
    if (quietMs >= REENTRY.minQuietMs && back !== -1 && j <= last && wasLoud) {
      const floor = Math.min(...energy.slice(i, j));
      const depth = Math.round((loud - floor) * 1000) / 1000;
      // The cut goes a little way into the rise from the end of the stop to the return.
      const atStep = j + (back - j) * REENTRY.intoRise;
      found.push({ kind: "break", atMs: Math.round(atStep * stepMs), breakFromMs: i * stepMs, depth, quietMs, score: depth * Math.min(quietMs, 4000) });
    }
    i = j + 1;
  }
  return found.sort((a, b) => b.score - a.score).map(({ score: _score, ...rest }) => rest);
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
  return best ? { kind: "section", atMs: best.atMs, depth: Math.round(best.step * 1000) / 1000 } : null;
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
