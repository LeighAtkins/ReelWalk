/**
 * The cut grammar's rules (ADR 0087), read off a timeline: which technique each shot change uses, and whether the
 * reel keeps the owner's rule (output/plans/cut-grammar-2026-10-26.md):
 *
 *   no naked cuts           every shot change is a named technique (cut-schema.ts) chosen because the shots allow it
 *   variety                 no technique twice in a row; at most twice per reel
 *   eye trace               the attention point moves less than 15 % of the frame width across a cut, unless the cut
 *                           is the surprise
 *   motion never stops      nothing static for more than 1.5 s
 *   a surprise every 3–5 s  a pattern break (a reveal, a scale jump, a zoom-through) at least every 6 s
 *
 * The gate fails on a naked cut, two identical techniques in a row, a static span over 1.5 s or no surprise for over
 * 6 s. Pure: the planner checks its own cut with it, the critic reports it, the commands route returns it.
 */
import { clipDurationMs, clipStartsMs, timelineDurationMs, type Clip, type Timeline } from "./timeline";
import type { CutTechnique } from "./cut-schema";

export const CUT_GRAMMAR = {
  /** The eye may travel this far (fraction of the frame width) across a cut that is not a surprise. */
  eyeTraceMax: 0.15,
  /** Longest a shot may hold without camera or subject motion. */
  staticMaxMs: 1500,
  /** The planner aims for a surprise this often… */
  surpriseEveryMs: 5000,
  /** …and the gate fails beyond this. */
  surpriseGapMaxMs: 6000,
  /** Most uses of one technique in a reel (unless it is the reel's signature). */
  maxUsesPerReel: 2,
  /** A title counts as carried over a cut when it is on screen at least this long on both sides. */
  carryMs: 200,
} as const;

/** Techniques that are pattern breaks by nature: the critic counts them as surprises even without a `surprise` note. */
export const SURPRISING: ReadonlySet<CutTechnique> = new Set(["zoomThrough", "scaleJump", "occlusionWipe", "rackFocus"]);

/** What the drawn transition kinds are, in the vocabulary. */
function techniqueOfTransition(kind: Clip["transitionIn"]): CutTechnique | null {
  switch (kind) {
    case "fade":
    case "softDissolve":
      return "dissolve";
    case "focusPull":
      return "rackFocus";
    case "lightLeak":
      return "lightLeak";
    case "occlusionWipe":
      return "occlusionWipe";
    case "zoomThrough":
      return "zoomThrough";
    case "walk":
      return "matchDirection";
    default:
      return null;
  }
}

export type CutReading = {
  /** The cut into clip `index` (1-based over the clips: the first clip has no cut in). */
  index: number;
  clipId: string;
  atMs: number;
  /** Null: a naked cut. */
  technique: CutTechnique | null;
  reason: string | null;
  eyeTrace: number | null;
  surprise: string | null;
};

/** Every shot change of the reel and the technique it uses: the recorded one, the drawn transition, or a title carried across it. */
export function readCuts(timeline: Timeline): CutReading[] {
  const starts = clipStartsMs(timeline);
  return timeline.clips.slice(1).map((clip, i) => {
    const index = i + 1;
    const atMs = starts[index];
    const carried = timeline.texts.some((text) => !text.id.startsWith("room-") && text.startMs <= atMs - CUT_GRAMMAR.carryMs && text.endMs >= atMs + CUT_GRAMMAR.carryMs);
    const technique = clip.cut?.technique ?? techniqueOfTransition(clip.transitionIn) ?? (carried ? "graphicCarry" : null);
    const surprise = clip.cut?.surprise ?? (technique && SURPRISING.has(technique) ? technique : null);
    return { index, clipId: clip.id, atMs, technique, reason: clip.cut?.reason ?? (technique ? `drawn as ${clip.transitionIn}` : null), eyeTrace: clip.cut?.eyeTrace ?? null, surprise };
  });
}

/** Spans (reel ms) where nothing moves: a photo with no move, or a video the caller knows is still and that has no move added. */
export function staticSpans(timeline: Timeline, stillClipIds: ReadonlySet<string> = new Set()): [number, number][] {
  const starts = clipStartsMs(timeline);
  const spans: [number, number][] = [];
  timeline.clips.forEach((clip, index) => {
    const moved = Boolean(clip.camera) || clip.motion !== "none" || Boolean(clip.pano) || clip.cut?.motion === "real" || clip.cut?.motion === "virtual";
    const still = !moved && (clip.kind === "IMAGE" || stillClipIds.has(clip.id));
    if (!still) return;
    const from = starts[index], to = from + clipDurationMs(clip);
    const last = spans[spans.length - 1];
    if (last && last[1] === from) last[1] = to;
    else spans.push([from, to]);
  });
  return spans;
}

export type CutGrammarFailure = { kind: "naked-cut" | "repeat" | "static" | "no-surprise"; atMs: number; detail: string };
export type CutGrammarWarning = { kind: "overused" | "eye-jump"; atMs: number; detail: string };

export type CutGrammarReport = {
  cuts: CutReading[];
  nakedCuts: number;
  /** Cuts that use the same technique as the cut before. */
  repeats: number;
  /** Uses per technique. */
  uses: Partial<Record<CutTechnique, number>>;
  /** The largest eye-trace distance of a cut that is not a surprise, or null when none was measured. */
  worstEyeTrace: number | null;
  /** Longest span without motion (ms). */
  longestStaticMs: number;
  /** Longest stretch between surprises, counting from the start and to the end (ms). */
  longestNoSurpriseMs: number;
  pass: boolean;
  failures: CutGrammarFailure[];
  warnings: CutGrammarWarning[];
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * The reel against the cut grammar. `signature` is a technique the reel is built on (a background-swap walk) and may
 * repeat; `stillClipIds` names video clips the caller measured as still.
 */
export function cutGrammarReport(timeline: Timeline, options: { stillClipIds?: ReadonlySet<string>; signature?: CutTechnique | null } = {}): CutGrammarReport {
  const cuts = readCuts(timeline);
  const total = timelineDurationMs(timeline);
  const failures: CutGrammarFailure[] = [];
  const warnings: CutGrammarWarning[] = [];
  const uses: Partial<Record<CutTechnique, number>> = {};
  let repeats = 0;
  let worstEyeTrace: number | null = null;
  cuts.forEach((cut, i) => {
    if (!cut.technique) {
      failures.push({ kind: "naked-cut", atMs: cut.atMs, detail: `The cut at ${seconds(cut.atMs)} into clip ${cut.index + 1} is a plain cut with no technique behind it.` });
      return;
    }
    uses[cut.technique] = (uses[cut.technique] ?? 0) + 1;
    const before = cuts[i - 1]?.technique;
    if (before && before === cut.technique && cut.technique !== options.signature) {
      repeats++;
      failures.push({ kind: "repeat", atMs: cut.atMs, detail: `The cut at ${seconds(cut.atMs)} is a ${cut.technique} again, straight after another.` });
    }
    if (cut.eyeTrace !== null && !cut.surprise) {
      worstEyeTrace = Math.max(worstEyeTrace ?? 0, cut.eyeTrace);
      if (cut.eyeTrace > CUT_GRAMMAR.eyeTraceMax) warnings.push({ kind: "eye-jump", atMs: cut.atMs, detail: `The eye jumps ${Math.round(cut.eyeTrace * 100)} % of the frame across the cut at ${seconds(cut.atMs)}.` });
    }
  });
  for (const [technique, count] of Object.entries(uses) as [CutTechnique, number][]) {
    if (count > CUT_GRAMMAR.maxUsesPerReel && technique !== options.signature) {
      warnings.push({ kind: "overused", atMs: cuts.find((cut) => cut.technique === technique)!.atMs, detail: `${technique} is used ${count} times; keep a technique to two per reel.` });
    }
  }
  const spans = staticSpans(timeline, options.stillClipIds);
  let longestStaticMs = 0;
  for (const [from, to] of spans) {
    longestStaticMs = Math.max(longestStaticMs, to - from);
    if (to - from > CUT_GRAMMAR.staticMaxMs) failures.push({ kind: "static", atMs: from, detail: `Nothing moves from ${seconds(from)} to ${seconds(to)}.` });
  }
  const marks = [0, ...cuts.filter((cut) => cut.surprise).map((cut) => cut.atMs), total];
  let longestNoSurpriseMs = 0;
  for (let i = 1; i < marks.length; i++) {
    const gap = marks[i] - marks[i - 1];
    longestNoSurpriseMs = Math.max(longestNoSurpriseMs, gap);
    if (gap > CUT_GRAMMAR.surpriseGapMaxMs) failures.push({ kind: "no-surprise", atMs: marks[i - 1], detail: `No surprise from ${seconds(marks[i - 1])} to ${seconds(marks[i])}.` });
  }
  return {
    cuts, nakedCuts: cuts.filter((cut) => !cut.technique).length, repeats, uses, worstEyeTrace, longestStaticMs, longestNoSurpriseMs,
    pass: failures.length === 0, failures, warnings,
  };
}

/** Whether the reel was cut by the planner (or by hand to the grammar): any clip records a technique. */
export function hasCutGrammar(timeline: Timeline): boolean {
  return timeline.clips.some((clip) => clip.cut);
}
