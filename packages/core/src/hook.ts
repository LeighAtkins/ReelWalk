/**
 * The designed opening (ADR 0068). Instagram's skip decision is made in the
 * first three seconds, and every reel used to open on a caption over a
 * still-ish frame. `planHook` rewrites the first 1.5–3 s of a timeline to one
 * of five patterns, through the same primitives every other cut change uses
 * (move, trim, add; titles retimed by the attachment rule of ADR 0048), so
 * the shared composition renders it with nothing new and one undo removes it.
 *
 * Pure: the same timeline and inputs always give the same plan. Measured
 * things (motion per clip, speech per asset, a frame's luma) come in as
 * inputs; nothing here reads pixels or a clock.
 */
import { kineticTiming } from "./kinetic";
import type { MotionSample } from "./motion";
import { clipEnergyFromMotion, fallbackClipEnergy } from "./pacing";
import { isGeneratedAssetId } from "./presenter";
import { retimeTexts } from "./text-timing";
import { speechPhrases, type TranscriptWord } from "./transcript";
import {
  addClips,
  clipDurationMs,
  clipStartsMs,
  HOOK_PATTERNS,
  locate,
  MIN_CLIP_MS,
  moveClip,
  textSchema,
  textsAt,
  timelineDurationMs,
  trimClip,
  type Clip,
  type HookPattern,
  type Opening,
  type TextOverlay,
  type Timeline,
} from "./timeline";

export { HOOK_PATTERNS, type HookPattern, type Opening };

export const HOOK_PATTERN_LABELS: Record<HookPattern, string> = {
  "voice-in": "Voice in",
  "motion-in": "Motion in",
  "text-punch": "Text punch",
  "pattern-interrupt": "Pattern interrupt",
  question: "Question",
};

export const HOOK_PATTERN_DESCRIPTIONS: Record<HookPattern, string> = {
  "voice-in": "Opens on the presenter's first word, the title there within a tenth of a second.",
  "motion-in": "Opens on the shot that moves most, already mid-move.",
  "text-punch": "A big line lands in the first 300 ms, then the reel.",
  "pattern-interrupt": "0.6 s of the shot least like the rest, then a hard cut to the story.",
  question: "A boxed question, with what staying gets you underneath.",
};

/** Ids the planner writes; it clears them before planning again, so a re-plan never stacks openings. */
export const HOOK_TEXT_PREFIX = "hook-open-";
export const HOOK_INTERRUPT_CLIP_ID = "hook-open-interrupt";

/** How long the opening is designed for: titles end by here unless the reel is shorter. */
export const HOOK_WINDOW_MS = 3000;
/** A pattern interrupt's opening piece. */
export const INTERRUPT_MS = 600;
/** Where hook titles are centred: the middle of Instagram's safe area (60 px in on the left, 120 px of buttons on the right), so a wrapped line never reaches the button column. */
export const HOOK_X = 0.47;
/** The text punch is fully legible by here. */
export const PUNCH_LEGIBLE_MS = 300;

export type HookInputs = {
  /** The hook line(s); the first is the title. Without one the planner uses the speech, then `headline`. */
  titles?: readonly string[];
  /** What the viewer gets by staying. */
  promise?: string;
  /** Open on this clip (voice-in, motion-in, text-punch, question); the planner picks otherwise. */
  clipId?: string;
  /** Measured motion by clip id (motion.ts samples over the clip's source window), for motion-in and the interrupt. */
  motion?: Record<string, readonly MotionSample[]>;
  /** Measured motion energy by clip id (0–1, ADR 0059), used when there are no samples. */
  clipEnergy?: Record<string, number>;
  /** Mean luma (0–1) of each clip's opening frame, by clip id: the interrupt picks the shot that looks least like the story's. */
  clipLuma?: Record<string, number>;
  /** Words with source timings by asset id (the transcript), for voice-in. */
  speech?: Record<string, readonly TranscriptWord[]>;
  /** Source lengths by asset id: trims never run past a video's end. */
  sourceDurationsMs?: Record<string, number | null | undefined>;
  /** The reel's name, the last resort for a title. */
  headline?: string | null;
};

export type HookPlan = { timeline: Timeline; opening: Opening; note: string };

/** The timeline without any earlier plan's texts, interrupt piece and record. The order of the clips is left as it is. */
export function stripHook(timeline: Timeline): Timeline {
  const clips = timeline.clips.filter((clip) => clip.id !== HOOK_INTERRUPT_CLIP_ID);
  const texts = timeline.texts.filter((text) => !text.id.startsWith(HOOK_TEXT_PREFIX));
  const changed = clips.length !== timeline.clips.length || texts.length !== timeline.texts.length || timeline.opening;
  if (!changed) return timeline;
  const next = clips.length !== timeline.clips.length ? retimeTexts({ ...timeline, texts }, { ...timeline, clips, texts }) : { ...timeline, clips, texts };
  const { opening: _opening, ...rest } = next;
  void _opening;
  return rest as Timeline;
}

/** Plans the opening. Null when the pattern cannot be made from this reel (no speech for voice-in, no line for a punch, one clip for an interrupt). */
export function planHook(timeline: Timeline, pattern: HookPattern, inputs: HookInputs = {}): HookPlan | null {
  const base = stripHook(timeline);
  if (base.clips.length === 0) return null;
  const titles = (inputs.titles ?? []).map((title) => title.trim()).filter(Boolean).slice(0, 3);
  const promise = (inputs.promise ?? "").trim().slice(0, 120);
  const headline = inputs.headline?.trim() || null;
  switch (pattern) {
    case "voice-in": return voiceIn(base, inputs, titles, promise, headline);
    case "motion-in": return motionIn(base, inputs, titles, promise, headline);
    case "text-punch": return textPunch(base, inputs, titles, promise, headline);
    case "pattern-interrupt": return patternInterrupt(base, inputs, titles, promise, headline);
    case "question": return question(base, inputs, titles, promise, headline);
  }
}

// ── The patterns ────────────────────────────────────────────────

function voiceIn(base: Timeline, inputs: HookInputs, titles: string[], promise: string, headline: string | null): HookPlan | null {
  const speech = inputs.speech ?? {};
  const candidates = base.clips
    .filter((clip) => clip.kind === "VIDEO" && clip.volume > 0 && (speech[clip.assetId]?.length ?? 0) > 0)
    .filter((clip) => !inputs.clipId || clip.id === inputs.clipId);
  for (const clip of candidates) {
    const words = speech[clip.assetId]!;
    // The first word that plays inside the window, with enough of the take left after it.
    const word = words.find((w) => w.s >= clip.sourceStartMs - 300 && w.s < clip.sourceEndMs - Math.ceil(800 * clip.speed));
    if (!word) continue;
    const inMs = Math.max(0, word.s - 80);
    const moved = moveClip(base, clip.id, 0);
    const cut = trimClip(moved, clip.id, { sourceStartMs: inMs, sourceEndMs: clip.sourceEndMs }, inputs.sourceDurationsMs?.[clip.assetId] ?? undefined);
    if (clipDurationMs(cut.clips[0]) < MIN_CLIP_MS) continue;
    let next = retimeTexts(base, cut);
    const spoken = speechPhrases(words.filter((w) => w.s >= word.s), { maxWords: 5, maxMs: 2500 })[0]?.text ?? null;
    const title = titles[0] ?? spoken ?? headline;
    const used: string[] = [];
    if (title) {
      next = withText(next, { id: `${HOOK_TEXT_PREFIX}title`, text: title, startMs: 0, endMs: 2600, x: HOOK_X, y: 0.3, style: "headline", size: 1.15, animation: "pop", shadow: "strong" });
      used.push(title);
    }
    if (promise) next = withText(next, promiseText(promise, 700));
    return finish(next, "voice-in", used, promise, `Opens on "${(spoken ?? word.w).slice(0, 40)}" at 0 ms${title ? ", the title at 0 ms" : ""}.`);
  }
  return null;
}

/** The clip that moves most early on and where its move is strongest, from measured samples, else from energies. */
export function strongestEarlyMotion(timeline: Timeline, inputs: Pick<HookInputs, "motion" | "clipEnergy" | "clipId">): { clipId: string; inMs: number; energy: number; measured: boolean } | null {
  let best: { clipId: string; inMs: number; energy: number; measured: boolean } | null = null;
  for (const clip of timeline.clips) {
    if (inputs.clipId && clip.id !== inputs.clipId) continue;
    if (isGeneratedAssetId(clip.assetId)) continue; // A presenter take keeps its place; it is not b-roll.
    const samples = inputs.motion?.[clip.id];
    let candidate: { clipId: string; inMs: number; energy: number; measured: boolean };
    if (samples && samples.length > 0 && clip.kind === "VIDEO") {
      const energy = clipEnergyFromMotion(samples) ?? 0;
      // The strongest step inside the window, with 1.5 s of the shot left to play from there.
      const latest = clip.sourceEndMs - Math.ceil(1500 * clip.speed);
      let peak = -1, at = clip.sourceStartMs;
      for (const sample of samples) {
        if (sample.t < clip.sourceStartMs || sample.t > latest) continue;
        const seconds = Math.max(0.04, (sample.t2 - sample.t) / 1000);
        const speed = Math.hypot(sample.dx, sample.dy) / seconds + sample.change * 100;
        if (speed > peak) { peak = speed; at = sample.t; }
      }
      candidate = { clipId: clip.id, inMs: Math.max(clip.sourceStartMs, at), energy: Math.min(1, energy + Math.min(0.5, peak / 48)), measured: true };
    } else {
      const energy = inputs.clipEnergy?.[clip.id] ?? fallbackClipEnergy(clip);
      candidate = { clipId: clip.id, inMs: clip.sourceStartMs, energy, measured: inputs.clipEnergy?.[clip.id] !== undefined };
    }
    // Measured beats guessed; among equals the earlier clip keeps its place.
    if (!best || (candidate.measured && !best.measured) || (candidate.measured === best.measured && candidate.energy > best.energy + 0.02)) best = candidate;
  }
  return best;
}

function motionIn(base: Timeline, inputs: HookInputs, titles: string[], promise: string, headline: string | null): HookPlan | null {
  const pick = strongestEarlyMotion(base, inputs);
  if (!pick) return null;
  const clip = base.clips.find((item) => item.id === pick.clipId)!;
  const moved = moveClip(base, clip.id, 0);
  const cut = pick.inMs > clip.sourceStartMs
    ? trimClip(moved, clip.id, { sourceStartMs: pick.inMs, sourceEndMs: clip.sourceEndMs }, inputs.sourceDurationsMs?.[clip.assetId] ?? undefined)
    : moved;
  let next = retimeTexts(base, cut);
  const title = titles[0] ?? headline;
  const used: string[] = [];
  if (title) {
    next = withText(next, { id: `${HOOK_TEXT_PREFIX}title`, text: title, startMs: 150, endMs: 2600, x: HOOK_X, y: 0.3, style: "headline", size: 1.15, animation: "pop", shadow: "strong" });
    used.push(title);
  }
  if (promise) next = withText(next, promiseText(promise, 900));
  const index = base.clips.indexOf(clip);
  return finish(next, "motion-in", used, promise, `Opens on shot ${index + 1}${pick.inMs > clip.sourceStartMs ? ` ${((pick.inMs - clip.sourceStartMs) / 1000).toFixed(1)} s in, mid-move` : ""}${pick.measured ? "" : " (motion not measured; by its camera move)"}.`);
}

function textPunch(base: Timeline, inputs: HookInputs, titles: string[], promise: string, headline: string | null): HookPlan | null {
  const title = titles[0] ?? headline ?? (promise || null);
  if (!title) return null;
  let next = inputs.clipId ? retimeTexts(base, moveClip(base, inputs.clipId, 0)) : base;
  next = withText(next, {
    id: `${HOOK_TEXT_PREFIX}title`, text: title, startMs: 0, endMs: 2200, x: HOOK_X, y: 0.38, style: "headline", size: 1.5, animation: "none", shadow: "strong",
    kinetic: { preset: "words", startMs: 0, durationMs: PUNCH_LEGIBLE_MS },
  });
  if (promise && promise !== title) next = withText(next, promiseText(promise, 450));
  return finish(next, "text-punch", [title], promise, `"${title.slice(0, 40)}" lands by ${PUNCH_LEGIBLE_MS} ms.`);
}

/** The clip least like the story's first shot: by its opening frame's luma when measured, else by kind, room, look and motion. */
export function mostDifferentClip(timeline: Timeline, inputs: Pick<HookInputs, "clipLuma" | "clipEnergy" | "motion">): Clip | null {
  const story = timeline.clips[0];
  if (!story) return null;
  const energyOf = (clip: Clip) => {
    const samples = inputs.motion?.[clip.id];
    return (samples?.length ? clipEnergyFromMotion(samples) : null) ?? inputs.clipEnergy?.[clip.id] ?? fallbackClipEnergy(clip);
  };
  let best: { clip: Clip; score: number } | null = null;
  for (const clip of timeline.clips.slice(1)) {
    if (isGeneratedAssetId(clip.assetId) || clip.pano) continue;
    let score = 0;
    const a = inputs.clipLuma?.[story.id], b = inputs.clipLuma?.[clip.id];
    // A measured look outweighs what the clip's fields say about it.
    if (a !== undefined && b !== undefined) score += Math.abs(a - b) * 6;
    if (clip.kind !== story.kind) score += 1;
    if ((clip.room ?? "") !== (story.room ?? "")) score += 0.5;
    if (clip.filter !== story.filter) score += 0.25;
    score += Math.abs(energyOf(clip) - energyOf(story));
    if (!best || score > best.score + 0.01) best = { clip, score };
  }
  return best?.clip ?? null;
}

function patternInterrupt(base: Timeline, inputs: HookInputs, titles: string[], promise: string, headline: string | null): HookPlan | null {
  const pick = mostDifferentClip(base, inputs);
  if (!pick) return null;
  const source = pick.kind === "IMAGE" ? 0 : pick.sourceStartMs;
  const length = pick.kind === "IMAGE" ? INTERRUPT_MS : Math.ceil(INTERRUPT_MS * pick.speed);
  const piece: Clip = { ...pick, id: HOOK_INTERRUPT_CLIP_ID, sourceStartMs: source, sourceEndMs: source + length, transitionIn: "cut", volume: 0 };
  const after = addClips(base, [piece], 0);
  const story = after.clips[1].transitionIn === "cut" ? after : { ...after, clips: after.clips.map((clip, i) => (i === 1 ? { ...clip, transitionIn: "cut" as const } : clip)) };
  let next = retimeTexts(base, story);
  const title = titles[0] ?? headline;
  const used: string[] = [];
  if (title) {
    next = withText(next, { id: `${HOOK_TEXT_PREFIX}title`, text: title, startMs: 0, endMs: 2400, x: HOOK_X, y: 0.3, style: "headline", size: 1.15, animation: "pop", shadow: "strong" });
    used.push(title);
  }
  if (promise) next = withText(next, promiseText(promise, INTERRUPT_MS + 100));
  const index = base.clips.indexOf(pick);
  return finish(next, "pattern-interrupt", used, promise, `${INTERRUPT_MS} ms of shot ${index + 1}, then the story.`);
}

function question(base: Timeline, inputs: HookInputs, titles: string[], promise: string, headline: string | null): HookPlan | null {
  const raw = titles[0] ?? headline;
  if (!raw) return null;
  const asked = /[?？]$/.test(raw) ? raw : `${raw.replace(/[.!…]+$/, "")}?`;
  let next = inputs.clipId ? retimeTexts(base, moveClip(base, inputs.clipId, 0)) : base;
  next = withText(next, { id: `${HOOK_TEXT_PREFIX}question`, text: asked, startMs: 0, endMs: 2800, x: HOOK_X, y: 0.34, style: "box", size: 1.05, animation: "pop" });
  const answer = promise || "Watch to the end";
  next = withText(next, promiseText(answer, 500));
  return finish(next, "question", [asked], answer, `Asks "${asked.slice(0, 40)}"; promises "${answer.slice(0, 40)}".`);
}

// ── Pieces ──────────────────────────────────────────────────────

type HookText = Omit<TextOverlay, "endMs" | "color" | "font" | "pin" | "path" | "surface"> & { endMs: number; color?: string };

function promiseText(promise: string, startMs: number): HookText {
  return { id: `${HOOK_TEXT_PREFIX}promise`, text: promise, startMs, endMs: HOOK_WINDOW_MS + 200, x: HOOK_X, y: 0.62, style: "elegant", size: 0.85, animation: "pop", shadow: "strong", color: "#ffffff" };
}

/** Adds a hook text, cut to the reel; a reel too short for it gets none. */
function withText(timeline: Timeline, text: HookText): Timeline {
  const total = timelineDurationMs(timeline);
  const startMs = Math.max(0, Math.min(text.startMs, total - 300));
  const endMs = Math.min(total, text.endMs);
  if (endMs - startMs < 300) return timeline;
  const parsed = textSchema.parse({ ...text, startMs, endMs, color: text.color ?? "#ffffff", font: text.style === "elegant" ? "serif" : "sans" });
  return { ...timeline, texts: [...timeline.texts.filter((t) => t.id !== parsed.id), parsed] };
}

function finish(timeline: Timeline, pattern: HookPattern, titles: string[], promise: string, note: string): HookPlan {
  const first = timeline.clips[0];
  const opening: Opening = { pattern, clipId: first.id, inMs: first.sourceStartMs, titles, promise };
  return { timeline: { ...timeline, opening }, opening, note };
}

// ── Reading an opening ──────────────────────────────────────────

/** The moments an opening is compared on: 0, 0.5, 1.0 and 1.5 s. */
export const HOOK_FRAME_MS = [0, 500, 1000, 1500] as const;

export type OpeningMoment = { atMs: number; clipId: string; assetId: string; sourceMs: number; texts: TextOverlay[] };

/** What is on screen at each of the four moments: the clip, its source time and the titles. Moments past the reel's end are left out. */
export function openingMoments(timeline: Timeline): OpeningMoment[] {
  const starts = clipStartsMs(timeline);
  const out: OpeningMoment[] = [];
  for (const atMs of HOOK_FRAME_MS) {
    const at = locate(timeline, atMs);
    if (!at) continue;
    const clip = timeline.clips[at.index];
    const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
    out.push({ atMs, clipId: clip.id, assetId: clip.assetId, sourceMs: Math.round(clip.sourceStartMs + (atMs - starts[at.index]) * speed), texts: textsAt(timeline, atMs) });
  }
  return out;
}

/**
 * How long after a title appears it is fully readable, ms, from how the
 * composition brings it in: a pop is opaque after three frames and settled
 * by 150 ms, a fade takes 0.6 s, a rise 0.5 s, a typewriter its characters
 * at 14 a second; kinetic words and from-behind are read when their move ends.
 * These mirror the composition's constants (ReelComposition.tsx, look.ts).
 */
export function titleLegibleAtMs(text: Pick<TextOverlay, "text" | "style" | "animation" | "kinetic">): number {
  if (text.kinetic && text.kinetic.preset !== "count") {
    const { startMs, durationMs } = kineticTiming(text.kinetic);
    return startMs + durationMs;
  }
  const animation = text.animation === "auto" ? (text.style === "elegant" ? "fade" : "pop") : text.animation;
  switch (animation) {
    case "none": return 0;
    case "pop": return 150;
    case "fade": return 600;
    case "rise": return 500;
    case "type": return Math.round((text.text.length / 14) * 1000);
  }
  return 150;
}

// ── Hook lines ──────────────────────────────────────────────────

/** "write me 5 hooks", "give me hooks", "5 hook lines please": how many hook lines were asked for, or null when the words ask for something else. */
export function hookTextRequest(request: string): { count: number } | null {
  const words = request.trim();
  if (!/\bhooks?\b|\bhook lines?\b|\bopening lines?\b/i.test(words)) return null;
  if (!/\b(write|give|suggest|propose|draft|ideas?|options?|lines?|me)\b/i.test(words)) return null;
  // Not a request to change the reel's opening ("make the hook a question" goes to Ask).
  if (/\b(make|change|apply|use|set|put|cut)\b/i.test(words) && !/\b(write|give|suggest|propose|draft)\b/i.test(words)) return null;
  const count = Number(/\b(\d{1,2})\s+(?:hooks?|hook lines?|opening lines?|options?|ideas?)\b/i.exec(words)?.[1] ?? 5);
  return { count: Math.max(1, Math.min(8, Number.isFinite(count) ? count : 5)) };
}

export type HookSubject = { title: string; rooms?: readonly string[]; titles?: readonly string[]; price?: string | null; address?: string | null };

/** Hook lines with no model: plain questions and promises from what the reel knows. */
export function draftHookLines(subject: HookSubject, count = 5): string[] {
  const rooms = (subject.rooms ?? []).filter(Boolean);
  const room = rooms[0] ?? "kitchen";
  const last = rooms[rooms.length - 1] ?? "view";
  const where = subject.address?.trim() || subject.title.trim() || "this house";
  const lines = [
    `Would you live here?`,
    `Wait for the ${last}.`,
    `The ${room} alone is worth the tour.`,
    `Nobody shows you this part of ${where}.`,
    subject.price ? `${subject.price}. Here is what that buys.` : `Three things the photos miss.`,
    `Stay for the last room.`,
    `This is not what it looks like from the street.`,
    `Ten seconds. Every room.`,
  ];
  return [...new Set(lines.map((line) => line.replace(/\s+/g, " ").trim()))].slice(0, Math.max(1, Math.min(8, count)));
}
