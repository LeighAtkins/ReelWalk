/**
 * The cut planner (ADR 0087): the research spec and the owner's cut grammar as code. Given the clips, their shot
 * analysis (ADR 0086), the song's beat grid and the brief (what the listing is, the feel), it plans the whole cut:
 *
 *   order       along the walk: arrival → threshold → living → kitchen → details → private → view → leaving
 *   windows     each shot's in and out points from the analysis' best windows, ends put on a movement peak or inside
 *               an occluder when the footage offers one, never "the middle"
 *   lengths     varied: the opener 1.5–2.5 s, details 0.8–1.5 s, heroes 2–4 s; 30–45 s in all (25 s when the footage
 *               is short); nothing static over 1.5 s (a still window gets a virtual push or drift)
 *   reveal      the cut nearest the middle (45–55 %) is the reel's pattern break
 *   loop        the last shot runs into the first (the closer ends on the frame the opener starts from when one clip
 *               can give both)
 *   one take    a steady walk of 25 s or more is shipped as one shot
 *   techniques  every shot change gets a technique from the vocabulary (cut-schema.ts), chosen from what the two shots
 *               allow, never the same twice in a row, at most twice a reel, a surprise every 3–5 s; each records why
 *
 * Pure and deterministic: the same input always gives the same plan. `applyCutPlan` writes it onto a timeline; the
 * gate (cut-grammar.ts) checks the result.
 */
import { customCamera, type Camera } from "./camera";
import { CUT_GRAMMAR, cutGrammarReport, SURPRISING, type CutGrammarReport } from "./cut-grammar";
import type { CutIn, CutTechnique, WipeSide } from "./cut-schema";
import {
  attentionAt, directionsAgree, eyeTraceDistance, meanFlow, spanQuality, windowsNear,
  type FlowDirection, type PlannerAnalysis,
} from "./shot-facts";
import { MIN_CLIP_MS, type Clip, type Timeline, type Transition } from "./timeline";

export const CUT_FEELS = ["quiet", "classic", "lively"] as const;
export type CutFeel = (typeof CUT_FEELS)[number];
export const LISTING_KINDS = ["for-sale", "just-sold", "open-home", "for-rent", "not-listing"] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];
export type CutBrief = { listing: ListingKind; feel: CutFeel };

export const WALK_STAGES = ["arrival", "threshold", "living", "kitchen", "details", "private", "view", "leaving"] as const;
export type WalkStage = (typeof WALK_STAGES)[number];
export type ShotRole = "opener" | "hero" | "detail" | "closer";

/** One clip offered to the planner. `analysis` null: a photo, or a video not measured yet (it is still placed, with a virtual move). */
export type PlanSource = {
  clipId: string;
  assetId: string;
  kind: "VIDEO" | "IMAGE";
  durationMs: number;
  room: string | null;
  analysis: PlannerAnalysis | null;
  /** The clip has its own sound worth keeping under the music (no wind, no talking): J/L cuts may carry it. */
  hasAudio?: boolean;
};

/** The song's grid in song time; `sourceStartMs` is where the reel starts in the song. */
export type PlanBeats = { bpm: number; beatOffsetMs: number; sourceStartMs?: number; downbeats?: readonly number[] } | null;

export type PlanInput = { sources: readonly PlanSource[]; brief: CutBrief; beats?: PlanBeats; targetMs?: number };

export type PlannedShot = {
  /** The clip this shot is cut from. A second window of one clip gets a new id when applied. */
  sourceClipId: string;
  assetId: string;
  kind: "VIDEO" | "IMAGE";
  sourceStartMs: number;
  sourceEndMs: number;
  stage: WalkStage;
  role: ShotRole;
  camera: Camera | null;
  motion: "real" | "virtual";
  transitionIn: Transition;
  /** The technique into this shot; null only for the opener. */
  cut: CutIn | null;
  volume?: number;
  /** Why this window. */
  why: string;
};

export type CutPlan = {
  mode: "cut" | "oneTake";
  feel: CutFeel;
  shots: PlannedShot[];
  totalMs: number;
  /** The mid-point pattern break: the cut index (into `shots`) and when it lands. */
  reveal: { index: number; atMs: number } | null;
  /** The hook title carried across the first cut (graphic carry): keep it on screen until this reel time. */
  carryUntilMs: number | null;
  /** How the last frame flows into the first. */
  loopSeam: { technique: CutTechnique; reason: string; eyeTrace: number | null };
  notes: string[];
};

// ── Stages and lengths ──────────────────────────────────────────

const STAGE_WORDS: [WalkStage, RegExp][] = [
  ["arrival", /exterior|facade|façade|front|drone|aerial|street|outside|arrival|driveway|entrance gate/i],
  ["view", /view|pool|balcony|terrace|deck|garden|yard|patio|outdoor|courtyard|sea|ocean|beach|lake|sunset|dusk|rooftop|lagoon/i],
  ["threshold", /entry|entrance|foyer|hall|door|stair|corridor|landing/i],
  ["kitchen", /kitchen|butler|pantry|scullery/i],
  ["private", /bed|bath|ensuite|en-suite|study|office|wardrobe|laundry|powder|nursery/i],
  ["living", /living|lounge|family|dining|media|rumpus|sitting/i],
  ["details", /detail|close/i],
];

export function stageOf(room: string | null): WalkStage {
  for (const [stage, words] of STAGE_WORDS) if (room && words.test(room)) return stage;
  return "living";
}

type Range = { min: number; target: number; max: number };
const LENGTHS: Record<CutFeel, Record<ShotRole, Range> & { totalMs: number }> = {
  lively: { opener: { min: 1500, target: 1700, max: 2000 }, hero: { min: 2000, target: 2400, max: 2800 }, detail: { min: 800, target: 900, max: 1100 }, closer: { min: 2000, target: 2600, max: 3200 }, totalMs: 30_000 },
  classic: { opener: { min: 1500, target: 2000, max: 2500 }, hero: { min: 2400, target: 3000, max: 3600 }, detail: { min: 900, target: 1200, max: 1500 }, closer: { min: 2400, target: 3000, max: 3600 }, totalMs: 36_000 },
  quiet: { opener: { min: 1800, target: 2400, max: 2500 }, hero: { min: 3000, target: 3600, max: 4000 }, detail: { min: 1200, target: 1400, max: 1500 }, closer: { min: 3000, target: 3600, max: 4000 }, totalMs: 42_000 },
};
export const REEL_MS = { min: 30_000, max: 45_000, floor: 25_000 } as const;
/** A walk this long and steady ships as one take. */
export const ONE_TAKE_MS = 25_000;
/** Phone clips wobble at their start and stop. */
const GUARD_MS = 300;
/** Same-clip windows closer than this read as a jump cut. */
const SAME_CLIP_GAP_MS = 2500;
/** The upscale a virtual close-up may reach: source px across the reel's width at least this. */
const CLOSE_UP_MIN_PX = 540;

// ── Small helpers ───────────────────────────────────────────────

const r3 = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

function exitFlow(source: PlanSource, outMs: number) {
  return source.analysis ? meanFlow(source.analysis.samples, outMs - 500, outMs) : null;
}
function entryFlow(source: PlanSource, inMs: number) {
  return source.analysis ? meanFlow(source.analysis.samples, inMs, inMs + 500) : null;
}

/** Real source px across the reel frame's width when the picture fills it (a cover crop). */
function sourcePxAcross(analysis: PlannerAnalysis): number {
  return analysis.width / analysis.height > 9 / 16 ? analysis.height * (9 / 16) : analysis.width;
}

/** The closest a virtual close-up can push into this source without going soft, or null when it cannot. */
export function closeUpScale(analysis: PlannerAnalysis | null): number | null {
  if (!analysis) return null;
  const limit = Math.min(2, sourcePxAcross(analysis) / CLOSE_UP_MIN_PX);
  return limit >= 1.3 ? r3(Math.min(1.6, limit)) : null;
}

/** A virtual move for a still window: a 6 % push, or a drift that carries `direction` (content motion) across a cut. */
export function virtualMove(direction: FlowDirection | null): Camera {
  const s = 1.08, room = Math.floor(((s - 1) / (2 * s)) * 100 * 10) / 10;
  switch (direction) {
    case "right": return customCamera([{ p: 0, scale: s, x: -room, y: 0, ease: "linear" }, { p: 1, scale: s, x: room, y: 0, ease: "linear" }]);
    case "left": return customCamera([{ p: 0, scale: s, x: room, y: 0, ease: "linear" }, { p: 1, scale: s, x: -room, y: 0, ease: "linear" }]);
    case "down": return customCamera([{ p: 0, scale: s, x: 0, y: -room, ease: "linear" }, { p: 1, scale: s, x: 0, y: room, ease: "linear" }]);
    case "up": return customCamera([{ p: 0, scale: s, x: 0, y: room, ease: "linear" }, { p: 1, scale: s, x: 0, y: -room, ease: "linear" }]);
    case "pull": return customCamera([{ p: 0, scale: 1.08, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1.02, x: 0, y: 0, ease: "linear" }]);
    default: return customCamera([{ p: 0, scale: 1.02, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1.08, x: 0, y: 0, ease: "linear" }]);
  }
}

/** A virtual close-up: the crop centred on `point` (reel fractions at scale 1) at `scale`, with a 4 % micro push. */
export function closeUpCamera(point: { x: number; y: number }, scale: number): Camera {
  const room = ((scale - 1) / (2 * scale)) * 100;
  const x = r3(clamp((0.5 - point.x) * 100, -room, room)), y = r3(clamp((0.5 - point.y) * 100, -room, room));
  const end = Math.min(2, r3(scale * 1.04));
  const endRoom = ((end - 1) / (2 * end)) * 100;
  return customCamera([{ p: 0, scale, x: clamp(x, -20, 20), y: clamp(y, -20, 20), ease: "linear" }, { p: 1, scale: end, x: clamp(clamp(x, -endRoom, endRoom), -20, 20), y: clamp(clamp(y, -endRoom, endRoom), -20, 20), ease: "out" }]);
}

// ── The beat grid in reel time ──────────────────────────────────

function beatTimes(beats: PlanBeats | undefined, untilMs: number, downbeatsOnly: boolean): number[] {
  if (!beats || !beats.bpm) return [];
  const offset = beats.sourceStartMs ?? 0;
  if (downbeatsOnly && beats.downbeats?.length) return beats.downbeats.map((t) => t - offset).filter((t) => t > 0 && t < untilMs + 2000);
  const period = 60_000 / beats.bpm;
  const out: number[] = [];
  const first = beats.beatOffsetMs - offset;
  const k0 = Math.ceil((0 - first) / period);
  for (let k = k0; first + k * period < untilMs + 2000; k++) {
    const t = first + k * period;
    if (t > 0) out.push(Math.round(t));
    if (downbeatsOnly && !beats.downbeats?.length) k += 3;
  }
  return out;
}

// ── One take ────────────────────────────────────────────────────

/** The longest steady walk (a camera move one way, mostly steady) of at least 25 s in any clip, or null. */
export function steadyWalk(sources: readonly PlanSource[]): { source: PlanSource; startMs: number; endMs: number } | null {
  let best: { source: PlanSource; startMs: number; endMs: number } | null = null;
  for (const source of sources) {
    const analysis = source.analysis;
    if (!analysis) continue;
    // Consecutive moving segments driven by the camera, joined.
    let runStart: number | null = null, runEnd = 0;
    const consider = (startMs: number, endMs: number) => {
      const steady = analysis.samples.filter((s) => s.t >= startMs && s.t < endMs);
      const meanSteady = steady.length ? steady.reduce((sum, s) => sum + s.steady, 0) / steady.length : 0;
      if (endMs - startMs >= ONE_TAKE_MS && meanSteady >= 0.6 && (!best || endMs - startMs > best.endMs - best.startMs)) best = { source, startMs, endMs };
    };
    for (const segment of analysis.motion) {
      const moving = segment.direction !== "static" && (segment.mover === "camera" || segment.mover === "both");
      if (moving && runStart !== null && segment.startMs <= runEnd + 300) runEnd = segment.endMs;
      else if (moving) { if (runStart !== null) consider(runStart, runEnd); runStart = segment.startMs; runEnd = segment.endMs; }
      else if (runStart !== null) { consider(runStart, runEnd); runStart = null; }
    }
    if (runStart !== null) consider(runStart, runEnd);
  }
  return best;
}

// ── Slots: which shots, in which order ──────────────────────────

type Slot = {
  source: PlanSource;
  stage: WalkStage;
  role: ShotRole;
  lengthMs: number;
  /** A virtual close-up continuing the shot before it (a scale jump). */
  closeUpOf?: number;
  /** A second look at a clip: its window must keep clear of the clip's other windows. */
  second?: boolean;
  startMs?: number;
  why?: string;
};

function motionOf(source: PlanSource): number {
  const a = source.analysis;
  if (!a || !a.samples.length) return 0;
  return a.samples.reduce((sum, s) => sum + s.flow.magnitude, 0) / a.samples.length;
}

function orderSources(sources: readonly PlanSource[]): PlanSource[] {
  const rank = (source: PlanSource) => WALK_STAGES.indexOf(stageOf(source.room));
  const indexed = sources.map((source, index) => ({ source, index }));
  indexed.sort((a, b) => rank(a.source) - rank(b.source) || a.index - b.index);
  const ordered = indexed.map((entry) => entry.source);
  // Open on the most spatial outside shot (the most movement among the arrivals), else the clip that moves most.
  const arrivals = ordered.filter((source) => stageOf(source.room) === "arrival");
  const pool = arrivals.length ? arrivals : ordered.filter((source) => stageOf(source.room) === "threshold");
  // The widest first: an aerial or drone shot is the most spatial; then the most movement.
  const spatial = (source: PlanSource) => (/aerial|drone|overhead/i.test(source.room ?? "") ? 1 : 0);
  const opener = (pool.length ? pool : ordered).slice().sort((a, b) => spatial(b) - spatial(a) || motionOf(b) - motionOf(a) || ordered.indexOf(a) - ordered.indexOf(b))[0];
  return [opener, ...ordered.filter((source) => source !== opener)];
}

function available(source: PlanSource): number {
  return Math.max(0, source.durationMs - (source.kind === "VIDEO" ? 2 * GUARD_MS : 0));
}

function buildSlots(sources: readonly PlanSource[], feel: CutFeel, targetMs: number): Slot[] {
  const L = LENGTHS[feel];
  const ordered = orderSources(sources);
  const opener = ordered[0];
  const slots: Slot[] = [{ source: opener, stage: stageOf(opener.room), role: "opener", lengthMs: L.opener.target }];
  for (const source of ordered.slice(1)) {
    slots.push({ source, stage: stageOf(source.room), role: "hero", lengthMs: Math.min(L.hero.target, Math.max(MIN_CLIP_MS, available(source))) });
  }
  // The closer: the opener's clip again when it is long enough to give the frames just before the opening (the loop).
  const closerFits = opener.kind === "VIDEO" && available(opener) >= L.opener.target + L.closer.min + 400;
  if (closerFits) slots.push({ source: opener, stage: "leaving", role: "closer", lengthMs: L.closer.target });
  const total = () => slots.reduce((sum, slot) => sum + slot.lengthMs, 0);
  const used = (source: PlanSource) => slots.filter((slot) => slot.source === source).reduce((sum, slot) => sum + slot.lengthMs, 0);

  // Short of the target: heroes first run to their longest, then virtual close-ups (scale jumps) of the clips that
  // can give them, then a second look at the longest clips.
  for (const slot of slots) if (total() < targetMs && slot.role === "hero") slot.lengthMs = Math.min(L.hero.max, Math.max(slot.lengthMs, Math.min(L.hero.max, available(slot.source) - used(slot.source) + slot.lengthMs)));
  const heroes = slots.filter((slot) => slot.role === "hero" && closeUpScale(slot.source.analysis));
  for (const hero of heroes) {
    // At most two scale jumps a reel (the grammar's limit for any one technique).
    if (total() >= targetMs || slots.filter((slot) => slot.closeUpOf !== undefined).length >= CUT_GRAMMAR.maxUsesPerReel) break;
    if (available(hero.source) - used(hero.source) < L.detail.min) continue;
    const index = slots.indexOf(hero);
    slots.splice(index + 1, 0, { source: hero.source, stage: hero.stage, role: "detail", lengthMs: L.detail.target, closeUpOf: index });
    // Indices after the insert moved: re-point later close-ups.
    slots.forEach((slot, i) => { if (slot.closeUpOf !== undefined && i > index + 1 && slot.closeUpOf > index) slot.closeUpOf++; });
  }
  let guard = 0;
  while (total() < targetMs && guard++ < 20) {
    const candidates = slots.filter((slot) => slot.role === "hero" && !slot.second && available(slot.source) - used(slot.source) >= L.detail.target + SAME_CLIP_GAP_MS)
      .sort((a, b) => (available(b.source) - used(b.source)) - (available(a.source) - used(a.source)));
    const hero = candidates.find((slot) => !slots.some((other) => other.second && other.source === slot.source));
    if (!hero) break;
    const index = slots.indexOf(hero) + (slots[slots.indexOf(hero) + 1]?.closeUpOf === slots.indexOf(hero) ? 2 : 1);
    const room = available(hero.source) - used(hero.source) - SAME_CLIP_GAP_MS;
    slots.splice(index, 0, { source: hero.source, stage: hero.stage, role: room >= L.hero.min ? "hero" : "detail", lengthMs: room >= L.hero.min ? Math.min(L.hero.target, room) : L.detail.target, second: true });
    slots.forEach((slot, i) => { if (slot.closeUpOf !== undefined && i > index && slot.closeUpOf >= index) slot.closeUpOf++; });
  }
  // Over the ceiling: trim heroes toward their shortest, then drop second looks from the end.
  for (const slot of slots) if (total() > REEL_MS.max && slot.role === "hero") slot.lengthMs = Math.max(L.hero.min, slot.lengthMs - (total() - REEL_MS.max));
  for (let i = slots.length - 1; i > 0 && total() > REEL_MS.max; i--) if (slots[i].second || slots[i].closeUpOf !== undefined) slots.splice(i, 1);
  return slots;
}

// ── Windows: in and out points ──────────────────────────────────

/** Moments a shot would like to end on: movement peaks (cut on action) and occluders at their darkest. */
function endAnchors(analysis: PlannerAnalysis | null): { t: number; kind: "action" | "occluder" }[] {
  if (!analysis) return [];
  return [
    ...analysis.flowPeaks.map((peak) => ({ t: peak.t, kind: "action" as const })),
    ...analysis.occluders.filter((o) => o.score >= 0.4).map((o) => ({ t: o.peakMs, kind: "occluder" as const })),
  ];
}

function overlaps(a: [number, number], b: [number, number], gap: number): boolean {
  return a[0] < b[1] + gap && b[0] < a[1] + gap;
}

/** Picks every slot's window: the best scored window of its length, nudged so it ends on an anchor when one is near. */
function placeWindows(slots: Slot[], feel: CutFeel): void {
  const taken = new Map<PlanSource, [number, number][]>();
  const take = (source: PlanSource, span: [number, number]) => taken.set(source, [...(taken.get(source) ?? []), span]);
  const free = (source: PlanSource, span: [number, number], gap: number) => (taken.get(source) ?? []).every((other) => !overlaps(span, other, gap));
  const closer = slots.find((slot) => slot.role === "closer");

  // The opener first (the closer is placed from it), then close-ups after their heroes, the rest in order.
  const order = [0, ...slots.map((_, i) => i).filter((i) => i > 0 && slots[i].closeUpOf === undefined && slots[i].role !== "closer"), ...slots.map((_, i) => i).filter((i) => slots[i].closeUpOf !== undefined)];
  for (const i of order) {
    const slot = slots[i];
    const { source } = slot;
    const length = Math.min(slot.lengthMs, Math.max(MIN_CLIP_MS, source.durationMs));
    slot.lengthMs = length;
    if (source.kind === "IMAGE" || !source.analysis) {
      const start = source.kind === "IMAGE" ? 0 : Math.max(0, Math.round((source.durationMs - length) / 2));
      slot.startMs = start;
      slot.why = source.analysis ? "the clip's middle" : "not measured yet: the middle of the clip, with a virtual move";
      take(source, [start, start + length]);
      continue;
    }
    if (slot.closeUpOf !== undefined) {
      // A scale jump continues the same moment: the close-up starts on the frame the wide ended.
      const wide = slots[slot.closeUpOf];
      const start = Math.min(source.durationMs - length, (wide.startMs ?? 0) + wide.lengthMs);
      slot.startMs = Math.max(0, start);
      slot.why = "the same moment as the wide before it, closer";
      take(source, [slot.startMs, slot.startMs + length]);
      continue;
    }
    const lo = GUARD_MS, hi = source.durationMs - GUARD_MS - length;
    const minStart = slot.role === "opener" && closer ? lo + LENGTHS[feel].closer.min + 100 : lo;
    const candidates: { start: number; score: number; why: string }[] = [];
    for (const window of windowsNear(source.analysis, length)) {
      const start = clamp(Math.round(window.startMs + (window.endMs - window.startMs - length) / 2), minStart, hi);
      candidates.push({ start, score: window.score, why: `best window (${window.score.toFixed(2)})` });
    }
    for (const anchor of endAnchors(source.analysis)) {
      const start = clamp(Math.round(anchor.t - length), minStart, hi);
      if (Math.abs(start + length - anchor.t) > 40) continue;
      candidates.push({ start, score: spanQuality(source.analysis, start, start + length) + (anchor.kind === "occluder" ? 0.12 : 0.08), why: anchor.kind === "occluder" ? "ends inside an occluder" : "ends on a movement peak" });
    }
    if (!candidates.length || hi < lo) candidates.push({ start: clamp(Math.round((source.durationMs - length) / 2), 0, Math.max(0, source.durationMs - length)), score: 0, why: "the clip's middle (nothing scored)" });
    candidates.sort((a, b) => b.score - a.score || a.start - b.start);
    const gap = slot.second || taken.has(source) ? SAME_CLIP_GAP_MS : 0;
    const pick = candidates.find((c) => free(source, [c.start, c.start + length], gap))
      ?? Array.from({ length: Math.max(1, Math.floor((source.durationMs - length) / 250)) }, (_, k) => ({ start: k * 250, score: 0, why: "the clearest free part of the clip" }))
        .find((c) => free(source, [c.start, c.start + length], gap));
    slot.startMs = pick?.start ?? clamp(0, 0, Math.max(0, source.durationMs - length));
    slot.why = pick?.why ?? "the clip's start";
    take(source, [slot.startMs, slot.startMs + length]);
  }
  if (closer) {
    // The frames just before the opening: the replay continues the closer's own camera move.
    const opener = slots[0];
    const end = opener.startMs ?? 0;
    const start = Math.max(0, end - closer.lengthMs);
    closer.lengthMs = end - start;
    closer.startMs = start;
    closer.why = "the frames just before the opening, so the replay runs straight on";
  }
}

// ── Lengths onto the beat ───────────────────────────────────────

function snapToBeats(slots: Slot[], beats: PlanBeats | undefined, feel: CutFeel): number {
  if (feel === "quiet" || !beats?.bpm) return 0;
  const period = 60_000 / beats.bpm;
  const grid = beatTimes(beats, slots.reduce((sum, slot) => sum + slot.lengthMs, 0) + 4000, false);
  let at = 0, snapped = 0;
  for (const [i, slot] of slots.entries()) {
    if (i === slots.length - 1) break;
    const end = at + slot.lengthMs;
    const nearest = grid.reduce((best, t) => (Math.abs(t - end) < Math.abs(best - end) ? t : best), Number.POSITIVE_INFINITY);
    const shift = nearest - end;
    const range = LENGTHS[feel][slot.role];
    const room = slot.source.kind === "IMAGE" ? Infinity : slot.source.durationMs - (slot.startMs ?? 0) - slot.lengthMs;
    const tolerance = feel === "lively" ? period / 2 : period * 0.3;
    if (Math.abs(shift) <= tolerance && slot.lengthMs + shift >= range.min * 0.9 && slot.lengthMs + shift <= range.max * 1.1 && shift <= room && slot.closeUpOf === undefined && slot.role !== "closer") {
      slot.lengthMs = Math.round(slot.lengthMs + shift);
      snapped++;
    }
    at += slot.lengthMs;
  }
  return snapped;
}

// ── Techniques ──────────────────────────────────────────────────

type Candidate = { technique: CutTechnique; strength: number; reason: string; transition: Transition; extra?: Partial<CutIn>; surprise?: string };

type CutContext = {
  a: Slot; b: Slot; index: number; atMs: number; outMs: number; inMs: number;
  beats: number[]; feel: CutFeel; carry: boolean; reveal: boolean; sinceSurpriseMs: number;
  /** The next shot change (or the end) would come too late for a surprise: this cut must be one. */
  mustSurprise?: boolean;
};

function hexDistance(a: string, b: string): number {
  const p = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) / 441.7;
}

const WIPE_FROM: Record<"left" | "right" | "up" | "down", WipeSide> = { right: "left", left: "right", down: "top", up: "bottom" };

/** Everything the two shots allow at this cut, strongest first. */
export function cutCandidates(ctx: CutContext): Candidate[] {
  const { a, b, outMs, inMs } = ctx;
  const A = a.source.analysis, B = b.source.analysis;
  const out: Candidate[] = [];
  const exit = exitFlow(a.source, outMs), entry = entryFlow(b.source, inMs);
  const from = A ? attentionAt(A, outMs) : null, to = B ? attentionAt(B, inMs) : null;
  const eye = from && to ? r3(eyeTraceDistance(from, to)) : null;

  if (ctx.carry) out.push({ technique: "graphicCarry", strength: 1, transition: "cut", reason: "the hook line stays on screen while the picture changes under it" });
  if (b.closeUpOf !== undefined) out.push({ technique: "scaleJump", strength: 0.95, transition: "cut", surprise: "scale jump", reason: "wide to a close-up of the same moment, cropped from the same pixels, with a micro push" });

  // An occluder sweeping the lens at the cut: a hard cut inside its darkest frame, or a wipe along its edge.
  for (const [side, analysis, t] of [["a", A, outMs], ["b", B, inMs]] as const) {
    const occluder = analysis?.occluders.filter((o) => o.score >= 0.4 && o.startMs <= t + 250 && o.endMs >= t - 250).sort((x, y) => y.coverage * y.score - x.coverage * x.score)[0];
    if (!occluder) continue;
    if (occluder.coverage >= 0.75 && Math.abs(occluder.peakMs - t) <= 100) {
      out.push({ technique: "occlusionWipe", strength: 0.9, transition: "cut", surprise: "hidden cut", reason: `cut inside the ${occluder.near ? "near " : ""}occluder's darkest frame (${Math.round(occluder.coverage * 100)} % covered) in ${side === "a" ? "the outgoing" : "the incoming"} shot` });
    } else {
      const steps = 7;
      const edge = Array.from({ length: steps }, (_, k) => r3(clamp(occluder.edgeFrom + ((occluder.edgeTo - occluder.edgeFrom) * k) / (steps - 1), 0, 1)));
      const along = WIPE_FROM[occluder.direction] === "left" || WIPE_FROM[occluder.direction] === "top" ? edge : edge.map((e) => r3(1 - e));
      out.push({ technique: "occlusionWipe", strength: 0.8 * occluder.score + 0.1, transition: "occlusionWipe", surprise: "wipe", extra: { wipe: { from: WIPE_FROM[occluder.direction], edge: along, soft: 0.06 } },
        reason: `the next room is revealed behind the ${occluder.near ? "near " : ""}edge sweeping ${occluder.direction} across ${side === "a" ? "the outgoing" : "the incoming"} shot` });
    }
  }
  // A movement peak on the cut hides it.
  const peakA = A?.flowPeaks.find((peak) => Math.abs(peak.t - outMs) <= 120), peakB = B?.flowPeaks.find((peak) => Math.abs(peak.t - inMs) <= 120);
  if (peakA || peakB) out.push({ technique: "cutOnAction", strength: 0.75, transition: "cut", reason: `the cut sits on a peak of movement (${(peakA ?? peakB)!.direction}) in ${peakA ? "the outgoing" : "the incoming"} shot` });
  // Eye trace.
  if (eye !== null && eye <= CUT_GRAMMAR.eyeTraceMax) out.push({ technique: "eyeTrace", strength: 0.82 - eye, transition: "cut", extra: { eyeTrace: eye }, reason: `the eye stays put: attention moves ${Math.round(eye * 100)} % of the frame across the cut` });
  // Direction carried across, real or by a drift added to a still incoming shot.
  if (exit && entry && directionsAgree(exit.direction, entry.direction)) out.push({ technique: "matchDirection", strength: 0.72, transition: "cut", reason: `the ${exit.direction} movement carries straight into the next shot` });
  else if (exit && exit.direction !== "static" && (!entry || entry.direction === "static")) out.push({ technique: "matchDirection", strength: 0.45, transition: "cut", extra: { motion: "virtual" }, reason: `the ${exit.direction} movement carries on as a drift added to the still next shot` });
  // Zoom through: a forward move into a window, door or the brightest region, the next room out of the matching region.
  const due = ctx.reveal || ctx.mustSurprise || ctx.sinceSurpriseMs >= 3000;
  if (A && B && exit && (exit.direction === "push" || due)) {
    const blowout = A.scene.blowouts.filter((bo) => Math.abs(bo.t - outMs) <= 1500 && bo.share <= 0.4).sort((x, y) => y.share - x.share)[0];
    const target = blowout ? attentionPoint(A, { x: blowout.box.x + blowout.box.w / 2, y: blowout.box.y + blowout.box.h / 2 }, outMs) : from;
    if (target && to && target.x > 0.1 && target.x < 0.9) {
      out.push({ technique: "zoomThrough", strength: blowout ? 0.85 : exit.direction === "push" ? 0.6 : 0.35, transition: "zoomThrough", surprise: "zoom through",
        extra: { zoom: { ax: r3(target.x), ay: r3(clamp(target.y, 0.1, 0.9)), bx: r3(clamp(to.x, 0.1, 0.9)), by: r3(clamp(to.y, 0.1, 0.9)), scale: 2.4 } },
        reason: blowout ? `pushes through the ${blowout.kind} and comes out in the next room` : "pushes into where the eye is and emerges from the same spot in the next room" });
    }
  }
  // Depth: a rack focus where either side has real depth.
  const depthA = A?.depth.filter((d) => Math.abs(d.t - outMs) <= 1500).sort((x, y) => Math.abs(x.t - outMs) - Math.abs(y.t - outMs))[0];
  const depthB = B?.depth.filter((d) => Math.abs(d.t - inMs) <= 1500).sort((x, y) => Math.abs(x.t - inMs) - Math.abs(y.t - inMs))[0];
  const spread = Math.max(depthA?.spread ?? 0, depthB?.spread ?? 0);
  if (spread >= 0.35) {
    const grid = (d: typeof depthA) => (d && d.cols >= 2 && d.rows >= 2 && d.cols <= 64 && d.rows <= 64 && d.grid.length <= 8192 ? { cols: d.cols, rows: d.rows, grid: d.grid } : undefined);
    out.push({ technique: "rackFocus", strength: 0.5 + spread * 0.3, transition: "focusPull", surprise: "depth change", extra: { depth: { a: grid(depthA), b: grid(depthB) } },
      reason: `focus slides through the depth (${Math.round(spread * 100)} % spread): the far wall goes first, the next room resolves out of the blur` });
  } else if (due) {
    // No measured depth: the plain focus pull still reads as a change of focus, the pattern break that was due.
    out.push({ technique: "rackFocus", strength: 0.3, transition: "focusPull", surprise: "focus change", reason: "a surprise was due: focus lets go of this room and the next resolves out of the blur" });
  }
  // Shape or colour carried across.
  if (A?.scene.round && B?.scene.round && A.scene.round.score >= 0.5 && B.scene.round.score >= 0.5) out.push({ technique: "shapeMatch", strength: 0.66, transition: "cut", reason: "a round shape here becomes a round shape there" });
  else if (A?.scene.palette[0] && B?.scene.palette[0] && hexDistance(A.scene.palette[0].hex, B.scene.palette[0].hex) <= 0.12) out.push({ technique: "shapeMatch", strength: 0.55, transition: "cut", reason: `the same colour (${A.scene.palette[0].hex}) carries across the cut` });
  // Light coming up at the cut.
  const ramp = [...(A?.scene.brightnessRamps.filter((r) => r.kind === "up" && Math.abs(r.endMs - outMs) <= 1000) ?? []), ...(B?.scene.brightnessRamps.filter((r) => r.kind === "up" && Math.abs(r.startMs - inMs) <= 1000) ?? [])][0];
  // A glint is a light change: the pattern break of last resort when one is due and nothing else is possible.
  out.push({ technique: "lightLeak", strength: ramp ? 0.6 : due ? 0.15 : 0.2, transition: "lightLeak", ...(ramp ? { surprise: "light change" } : due ? { surprise: "glint" } : {}), reason: ramp ? "the light comes up on the cut and a soft glint carries it" : "a soft glint carries the cut" });
  // A downbeat.
  const beat = ctx.beats.find((t) => Math.abs(t - ctx.atMs) <= 40);
  if (beat !== undefined) out.push({ technique: "beatCut", strength: ctx.feel === "lively" ? 0.62 : 0.5, transition: "cut", reason: "a hard cut on the downbeat after the build" });
  out.push({ technique: "dissolve", strength: ctx.feel === "quiet" ? 0.4 : 0.12, transition: ctx.feel === "quiet" ? "softDissolve" : "fade", reason: "a soft dissolve lets time pass between the rooms" });
  return out.map((c) => ({ ...c, extra: { ...(eye !== null && c.extra?.eyeTrace === undefined ? { eyeTrace: eye } : {}), ...c.extra } }));
}

function attentionPoint(analysis: PlannerAnalysis, p: { x: number; y: number }, t: number) {
  const sample = analysis.samples.length ? { ...analysis.samples[0], saliency: { ...p, strength: 1 } } : null;
  if (!sample) return null;
  // The source point through the same crop as the saliency.
  return attentionAt({ ...analysis, samples: [{ ...sample, t }] }, t);
}

/**
 * Picks the technique for a cut: the strongest the shots allow that is not the last cut's and not used twice yet;
 * when a surprise is due (3 s or more since the last), a surprising one gets the edge, and at the reveal it must be
 * one if any is possible.
 */
export function chooseTechnique(candidates: Candidate[], previous: CutTechnique | null, uses: Partial<Record<CutTechnique, number>>, ctx: Pick<CutContext, "sinceSurpriseMs" | "reveal" | "mustSurprise">): Candidate {
  // Surprises are spaced: kept back under 2.5 s since the last (each kind may be used only twice), favoured from
  // 3.5 s, and close to certain by 5 s.
  const since = ctx.sinceSurpriseMs;
  const pull = ctx.mustSurprise ? 1.2 : ctx.reveal ? 0.6 : since >= 3500 ? 0.3 + (since - 3500) / 2500 : since < 2500 ? -0.4 : 0;
  const score = (c: Candidate) => c.strength + (SURPRISING.has(c.technique) || c.surprise ? pull : 0);
  const allowed = candidates.filter((c) => c.technique !== previous && (uses[c.technique] ?? 0) < CUT_GRAMMAR.maxUsesPerReel);
  const pool = allowed.length ? allowed : candidates.filter((c) => c.technique !== previous);
  return [...(pool.length ? pool : candidates)].sort((x, y) => score(y) - score(x) || CUT_ORDER.indexOf(x.technique) - CUT_ORDER.indexOf(y.technique))[0];
}
const CUT_ORDER: CutTechnique[] = ["graphicCarry", "scaleJump", "occlusionWipe", "zoomThrough", "eyeTrace", "cutOnAction", "matchDirection", "rackFocus", "shapeMatch", "beatCut", "lightLeak", "dissolve"];

// ── The plan ────────────────────────────────────────────────────

export function planCut(input: PlanInput): CutPlan {
  const { brief } = input;
  const feel = brief.feel;
  const sources = input.sources.filter((source) => source.durationMs >= MIN_CLIP_MS);
  const notes: string[] = [];
  if (!sources.length) throw new Error("There are no clips to plan a cut from.");

  // One take: a steady walk of 25 s or more is the reel.
  const walk = steadyWalk(sources);
  if (walk && feel !== "lively") {
    const end = Math.min(walk.endMs, walk.startMs + REEL_MS.max);
    const shot: PlannedShot = { sourceClipId: walk.source.clipId, assetId: walk.source.assetId, kind: walk.source.kind, sourceStartMs: walk.startMs, sourceEndMs: end, stage: stageOf(walk.source.room), role: "opener", camera: null, motion: "real", transitionIn: "cut", cut: null, why: `a steady walk of ${((end - walk.startMs) / 1000).toFixed(1)} s: shipped as one take` };
    return { mode: "oneTake", feel, shots: [shot], totalMs: end - walk.startMs, reveal: null, carryUntilMs: null, loopSeam: { technique: "matchDirection", reason: "one continuous walk", eyeTrace: null }, notes: ["one take: the walk carries every room"] };
  }

  const footage = sources.reduce((sum, source) => sum + available(source), 0);
  const targetMs = clamp(input.targetMs ?? LENGTHS[feel].totalMs, REEL_MS.min, REEL_MS.max);
  const reachable = Math.min(targetMs, Math.max(REEL_MS.floor, footage * 0.7));
  if (reachable < targetMs) notes.push(`only ${(footage / 1000).toFixed(0)} s of usable footage: aiming at ${(reachable / 1000).toFixed(0)} s`);
  const slots = buildSlots(sources, feel, reachable);
  placeWindows(slots, feel);
  const snapped = snapToBeats(slots, input.beats, feel);
  if (snapped) notes.push(`${snapped} cut${snapped === 1 ? "" : "s"} on the beat`);

  const totalMs = slots.reduce((sum, slot) => sum + slot.lengthMs, 0);
  const starts: number[] = [];
  slots.reduce((at, slot) => (starts.push(at), at + slot.lengthMs), 0);
  // The reveal: the cut nearest the middle, inside 45–55 % when one is there.
  const middle = slots.map((_, i) => i).filter((i) => i > 1).sort((x, y) => Math.abs(starts[x] - totalMs / 2) - Math.abs(starts[y] - totalMs / 2))[0] ?? null;
  const reveal = middle !== null ? { index: middle, atMs: starts[middle] } : null;
  if (reveal && (reveal.atMs < totalMs * 0.45 || reveal.atMs > totalMs * 0.55)) notes.push(`the reveal lands at ${Math.round((reveal.atMs / totalMs) * 100)} %, outside 45–55 %: the shots did not allow closer`);

  const downbeats = beatTimes(input.beats, totalMs, feel !== "lively");
  const shots: PlannedShot[] = [];
  const uses: Partial<Record<CutTechnique, number>> = {};
  let previous: CutTechnique | null = null;
  let lastSurprise = 0;
  let carryUntilMs: number | null = null;
  for (const [i, slot] of slots.entries()) {
    const start = slot.startMs ?? 0;
    const analysis = slot.source.analysis;
    const flow = analysis ? meanFlow(analysis.samples, start, start + slot.lengthMs) : null;
    const moving = Boolean(flow && flow.direction !== "static");
    let camera: Camera | null = null;
    let motion: "real" | "virtual" = moving ? "real" : "virtual";
    if (slot.closeUpOf !== undefined && analysis) {
      const scale = closeUpScale(analysis)!;
      const box = analysis.reframe?.closeUps.filter((c) => c.startMs <= start + slot.lengthMs && c.endMs >= start).sort((x, y) => y.score - x.score)[0];
      const point = box ? attentionPoint(analysis, { x: box.box.x + box.box.w / 2, y: box.box.y + box.box.h / 2 }, start) : attentionAt(analysis, start);
      camera = closeUpCamera(point ?? { x: 0.5, y: 0.5 }, scale);
      motion = "virtual";
    }
    let cut: CutIn | null = null;
    let transitionIn: Transition = "cut";
    if (i > 0) {
      const a = slots[i - 1];
      const ctx: CutContext = { a, b: slot, index: i, atMs: starts[i], outMs: (a.startMs ?? 0) + a.lengthMs, inMs: start, beats: downbeats, feel, carry: i === 1, reveal: reveal?.index === i, sinceSurpriseMs: starts[i] - lastSurprise,
        mustSurprise: (starts[i + 1] ?? totalMs) - lastSurprise > CUT_GRAMMAR.surpriseGapMaxMs - 500 };
      const choice = chooseTechnique(cutCandidates(ctx), previous, uses, ctx);
      uses[choice.technique] = (uses[choice.technique] ?? 0) + 1;
      previous = choice.technique;
      const surprise = choice.surprise ?? (SURPRISING.has(choice.technique) ? choice.technique : undefined) ?? (reveal?.index === i ? "reveal" : undefined);
      if (surprise) lastSurprise = starts[i];
      transitionIn = choice.transition;
      cut = { technique: choice.technique, reason: choice.reason, ...(choice.extra ?? {}), ...(surprise ? { surprise } : {}), motion };
      if (choice.extra?.motion === "virtual" && !camera) {
        camera = virtualMove(exitFlow(a.source, ctx.outMs)?.direction ?? null);
        cut.motion = "virtual";
      }
      if (choice.technique === "graphicCarry") carryUntilMs = Math.min(starts[i] + 700, starts[i] + Math.floor(slot.lengthMs / 2));
    }
    if (motion === "virtual" && !camera) camera = virtualMove(i > 0 ? exitFlow(slots[i - 1].source, (slots[i - 1].startMs ?? 0) + slots[i - 1].lengthMs)?.direction ?? null : null);
    const why = slot.why ?? "";
    shots.push({ sourceClipId: slot.source.clipId, assetId: slot.source.assetId, kind: slot.source.kind, sourceStartMs: start, sourceEndMs: start + slot.lengthMs, stage: slot.stage, role: slot.role, camera, motion, transitionIn, cut: cut ? { ...cut, motion } : null, why });
  }

  // Sound: where both rooms have their own sound, the next room is heard first on a surprise (J), the last one lingers otherwise (L).
  for (const [i, shot] of shots.entries()) {
    const source = sources.find((s) => s.clipId === shot.sourceClipId);
    if (source?.hasAudio) shot.volume = feel === "quiet" ? 0.4 : 0.25;
    if (i === 0 || !shot.cut) continue;
    const before = sources.find((s) => s.clipId === shots[i - 1].sourceClipId);
    if (source?.hasAudio && before?.hasAudio && shot.assetId !== shots[i - 1].assetId) shot.cut = shot.cut.surprise ? { ...shot.cut, jMs: 300 } : { ...shot.cut, lMs: 300 };
  }

  // The loop seam: the last frame into the first.
  const first = shots[0], last = shots[shots.length - 1];
  const firstSource = sources.find((s) => s.clipId === first.sourceClipId)!, lastSource = sources.find((s) => s.clipId === last.sourceClipId)!;
  let loopSeam: CutPlan["loopSeam"];
  if (last.role === "closer" && last.sourceEndMs === first.sourceStartMs) loopSeam = { technique: "matchDirection", reason: "the closer ends on the frame the opener starts from: the replay is one continuous move", eyeTrace: 0 };
  else {
    const exit = exitFlow(lastSource, last.sourceEndMs), entry = entryFlow(firstSource, first.sourceStartMs);
    const from = lastSource.analysis ? attentionAt(lastSource.analysis, last.sourceEndMs) : null, to = firstSource.analysis ? attentionAt(firstSource.analysis, first.sourceStartMs) : null;
    const eye = from && to ? r3(eyeTraceDistance(from, to)) : null;
    loopSeam = exit && entry && directionsAgree(exit.direction, entry.direction)
      ? { technique: "matchDirection", reason: `the closing ${exit.direction} movement carries into the opening`, eyeTrace: eye }
      : eye !== null && eye <= CUT_GRAMMAR.eyeTraceMax ? { technique: "eyeTrace", reason: "the eye ends where the opening starts", eyeTrace: eye } : { technique: "lightLeak", reason: "no natural seam: the end card covers the jump", eyeTrace: eye };
  }
  return { mode: "cut", feel, shots, totalMs, reveal, carryUntilMs, loopSeam, notes };
}

// ── Onto a timeline ─────────────────────────────────────────────

/**
 * The plan written onto a timeline: its clips replace the reel's (each keeps the look and sound settings of the clip
 * it is cut from; a second window of a clip gets a new id). Titles are left for the caller to place (the hook is
 * carried until `plan.carryUntilMs`).
 */
export function applyCutPlan(timeline: Timeline, plan: CutPlan, newId: () => string): Timeline {
  const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
  const seen = new Set<string>();
  const clips: Clip[] = plan.shots.map((shot) => {
    const base = byId.get(shot.sourceClipId);
    if (!base) throw new Error(`The plan cuts from clip ${shot.sourceClipId}, which is not in the reel.`);
    const id = seen.has(base.id) ? newId() : base.id;
    seen.add(base.id);
    const clip: Clip = {
      ...base, id, sourceStartMs: shot.sourceStartMs, sourceEndMs: shot.sourceEndMs, speed: 1, transitionIn: shot.transitionIn, motion: "none", zoom: 1, ramp: null,
      camera: shot.camera, ...(shot.volume !== undefined ? { volume: shot.volume } : {}),
    };
    delete clip.whipDirection;
    if (shot.cut) clip.cut = shot.cut;
    else delete clip.cut;
    return clip;
  });
  const cover = timeline.cover && clips.some((clip) => clip.id === timeline.cover!.clipId) ? timeline.cover : null;
  return { ...timeline, clips, cover };
}

/** The gate on a planned timeline (one take is exempt from the surprise spacing: the walk is its own reveal). */
export function planReport(timeline: Timeline, plan: Pick<CutPlan, "mode">): CutGrammarReport {
  const report = cutGrammarReport(timeline);
  if (plan.mode !== "oneTake") return report;
  const failures = report.failures.filter((f) => f.kind !== "no-surprise");
  return { ...report, failures, pass: failures.length === 0 };
}

/** The plan as lines a person or the director can read: one per shot change, with its technique and why. */
export function describeCutPlan(plan: CutPlan): string[] {
  let at = 0;
  return plan.shots.map((shot, i) => {
    const line = i === 0
      ? `0.0 s  open on ${shot.stage} (${shot.role}, ${((shot.sourceEndMs - shot.sourceStartMs) / 1000).toFixed(1)} s): ${shot.why}`
      : `${(at / 1000).toFixed(1)} s  ${shot.cut?.technique ?? "CUT"} into ${shot.stage} (${shot.role}, ${((shot.sourceEndMs - shot.sourceStartMs) / 1000).toFixed(1)} s): ${shot.cut?.reason ?? ""}${shot.cut?.surprise ? ` [surprise: ${shot.cut.surprise}]` : ""}`;
    at += shot.sourceEndMs - shot.sourceStartMs;
    return line;
  });
}
