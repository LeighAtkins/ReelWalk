/**
 * The hook rules (ADR 0068), checked at export by the critic (ADR 0062) and
 * shown in the Hook studio: no empty frame 0, a title legible by 300 ms,
 * motion or speech in the first 500 ms, nothing important under the top 13 %
 * (Instagram's header) or the right-hand button column. Pure: pixels and
 * measurements come in; a rule that needs a measurement it was not given
 * says so (`unknown`) rather than guessing.
 */
import { CRITIC, frameDifference, momentAt, titleGeometry, type CriticFrame } from "./critic";
import { titleLegibleAtMs } from "./hook";
import { INSTAGRAM } from "./instagram";
import type { MotionSample } from "./motion";
import type { Measure, TitleFont } from "./scene";
import { kineticTiming } from "./kinetic";
import type { TranscriptWord } from "./transcript";
import { clipDurationMs, REEL_FORMAT, type Clip, type TextOverlay, type Timeline } from "./timeline";

export type HookRule = "frame-0" | "title-300" | "motion-500" | "zones";

export type HookIssue = {
  rule: HookRule;
  /** True when the rule holds (or could not be judged: see `unknown`). */
  ok: boolean;
  /** Set when the rule needed a measurement it was not given; `ok` is then true and nothing was decided. */
  unknown?: true;
  reason: string;
  /** The title the zones rule is about. */
  textId?: string;
};

export type HookRulesInput = {
  /** Frames by the critic's sample key (`criticSamples`/`momentAt`): frame 0 and 500 ms are read. */
  frames?: ReadonlyMap<string, CriticFrame>;
  /** Measured motion by clip id, for the opening clip. */
  motion?: Record<string, readonly MotionSample[]>;
  /** Words with source timings by asset id. */
  speech?: Record<string, readonly TranscriptWord[]>;
  /** A title's font as the renderer styles it; without it a house estimate is used for the zone boxes. */
  titleFont?(text: TextOverlay): TitleFont;
  measure?: Measure;
};

export const HOOK_RULES = {
  titleByMs: 300,
  motionByMs: 500,
  /** The opening the zones rule looks at. */
  zonesWithinMs: 1500,
  /** A frame darker or brighter than this throughout is empty. */
  emptyLuma: { dark: 0.04, bright: 0.97, spread: 0.02 },
  /** How far a box may reach into a zone before it counts, px at 1080×1920 (the critic's own tolerance). */
  zoneTolerancePx: 24,
  /** Picture motion in the opening clip's samples: px/s at the 48-px analysis width, or a change between frames. */
  motion: { speedPxPerS: 6, change: 0.02 },
} as const;

const W = REEL_FORMAT.width, H = REEL_FORMAT.height;
const STYLE_SCALE: Record<string, number> = { headline: 1.3, elegant: 0.78, tag: 0.7 };
/** The composition's base size per style, close enough for a zone box when the renderer's font is not to hand. */
export const defaultTitleFont = (text: TextOverlay): TitleFont => ({ fontSize: 76 * text.size * (STYLE_SCALE[text.style] ?? 1) });

const cameraMoves = (clip: Clip) => clip.motion !== "none" || Boolean(clip.pano);

/** Runs the four rules on the reel's opening. */
export function hookRules(timeline: Timeline, input: HookRulesInput = {}): HookIssue[] {
  return [frameZero(timeline, input), titleBy300(timeline), motionBy500(timeline, input), zones(timeline, input)].flat();
}

export const hookPasses = (issues: readonly HookIssue[]) => issues.every((issue) => issue.ok);

function frameZero(timeline: Timeline, input: HookRulesInput): HookIssue {
  const first = timeline.clips[0];
  if (!first) return { rule: "frame-0", ok: false, reason: "The reel has no first shot." };
  const moment = momentAt(timeline, 0);
  const frame = moment ? input.frames?.get(moment.key) : undefined;
  if (!frame) return { rule: "frame-0", ok: true, unknown: true, reason: "Frame 0 was not read." };
  let sum = 0, min = 1, max = 0;
  for (const v of frame.luma) { sum += v; if (v < min) min = v; if (v > max) max = v; }
  const mean = sum / frame.luma.length;
  const flat = max - min < HOOK_RULES.emptyLuma.spread;
  if (flat && (mean < HOOK_RULES.emptyLuma.dark || mean > HOOK_RULES.emptyLuma.bright)) {
    return { rule: "frame-0", ok: false, reason: `Frame 0 is ${mean < 0.5 ? "black" : "white"}: the reel opens on nothing.` };
  }
  return { rule: "frame-0", ok: true, reason: "Frame 0 shows the picture." };
}

function titleBy300(timeline: Timeline): HookIssue {
  const early = timeline.texts.filter((text) => text.startMs <= HOOK_RULES.titleByMs && !text.id.startsWith("room-"));
  const legible = early.map((text) => ({ text, atMs: text.startMs + titleLegibleAtMs(text) })).sort((a, b) => a.atMs - b.atMs);
  const first = legible[0];
  if (first && first.atMs <= HOOK_RULES.titleByMs) return { rule: "title-300", ok: true, reason: `“${first.text.text.slice(0, 30)}” is readable by ${first.atMs} ms.`, textId: first.text.id };
  if (first) return { rule: "title-300", ok: false, reason: `The first title is only readable at ${first.atMs} ms; it should be by ${HOOK_RULES.titleByMs} ms.`, textId: first.text.id };
  return { rule: "title-300", ok: false, reason: `No title is on screen in the first ${HOOK_RULES.titleByMs} ms.` };
}

function motionBy500(timeline: Timeline, input: HookRulesInput): HookIssue {
  const first = timeline.clips[0];
  if (!first) return { rule: "motion-500", ok: false, reason: "The reel has no first shot." };
  const by = HOOK_RULES.motionByMs;
  if (cameraMoves(first)) return { rule: "motion-500", ok: true, reason: "The first shot has a camera move." };
  if (clipDurationMs(first) <= by) return { rule: "motion-500", ok: true, reason: `A cut lands at ${clipDurationMs(first)} ms.` };
  const speed = first.kind === "IMAGE" ? 1 : first.speed;
  const sourceBy = first.sourceStartMs + by * speed;
  const words = first.kind === "VIDEO" && first.volume > 0 ? input.speech?.[first.assetId] : undefined;
  if (words?.some((word) => word.s >= first.sourceStartMs - 200 && word.s < sourceBy)) return { rule: "motion-500", ok: true, reason: "Someone speaks in the first half second." };
  const kinetic = timeline.texts.find((text) => text.kinetic && text.kinetic.preset !== "count" && text.startMs + kineticTiming(text.kinetic).startMs < by);
  if (kinetic) return { rule: "motion-500", ok: true, reason: `“${kinetic.text.slice(0, 30)}” moves in.`, textId: kinetic.id };
  const samples = input.motion?.[first.id]?.filter((sample) => sample.t >= first.sourceStartMs && sample.t < sourceBy);
  if (samples?.length) {
    const moving = samples.some((sample) => Math.hypot(sample.dx, sample.dy) / Math.max(0.04, (sample.t2 - sample.t) / 1000) >= HOOK_RULES.motion.speedPxPerS || sample.change >= HOOK_RULES.motion.change);
    return moving ? { rule: "motion-500", ok: true, reason: "The picture moves in the first half second." } : { rule: "motion-500", ok: false, reason: `Nothing moves or speaks in the first ${by} ms.` };
  }
  const a = momentAt(timeline, 0), b = momentAt(timeline, by);
  const fa = a && input.frames?.get(a.key), fb = b && input.frames?.get(b.key);
  if (fa && fb) {
    return frameDifference(fa, fb) > CRITIC.motion
      ? { rule: "motion-500", ok: true, reason: "The picture changes in the first half second." }
      : { rule: "motion-500", ok: false, reason: `Nothing moves or speaks in the first ${by} ms.` };
  }
  if (first.kind === "IMAGE") return { rule: "motion-500", ok: false, reason: "The reel opens on a still photo with no camera move." };
  return { rule: "motion-500", ok: true, unknown: true, reason: "The first shot's motion was not measured." };
}

function zones(timeline: Timeline, input: HookRulesInput): HookIssue[] {
  const font = input.titleFont ?? defaultTitleFont;
  const top = INSTAGRAM.safeZonePx.top, right = W - INSTAGRAM.safeZonePx.right, tolerance = HOOK_RULES.zoneTolerancePx;
  const issues: HookIssue[] = [];
  for (const text of timeline.texts) {
    if (text.startMs >= HOOK_RULES.zonesWithinMs || text.id.startsWith("room-")) continue;
    const geometry = titleGeometry(timeline, text, font(text), input.measure);
    if (!geometry) continue;
    const box = geometry.box;
    const intoTop = top - box.y * H, intoRight = (box.x + box.w) * W - right;
    if (intoTop > tolerance) issues.push({ rule: "zones", ok: false, reason: `“${text.text.slice(0, 30)}” runs under the header (top 13 %).`, textId: text.id });
    else if (intoRight > tolerance) issues.push({ rule: "zones", ok: false, reason: `“${text.text.slice(0, 30)}” runs under the buttons on the right.`, textId: text.id });
  }
  return issues.length ? issues : [{ rule: "zones", ok: true, reason: "Nothing important sits under the header or the buttons." }];
}
