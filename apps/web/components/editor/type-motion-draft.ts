import { KINETIC_PRESET, nearestBeatMs, beatPeriodMs, REEL_FORMAT, SHINE_PRESET, TYPE_MOTION_START_MAX_MS, type Music, type TextOverlay } from "@reelwalk/core";

/**
 * The text sheet's motion choices (ADR 0061) on a draft: one Motion row (none, shine or kinetic), a preset under it,
 * and when it starts. Pure, so the sheet's rules are tested without a DOM.
 */
type Draft = Pick<TextOverlay, "shine" | "kinetic" | "callout" | "style" | "size" | "animation" | "blend">;

export type MotionMode = "none" | "shine" | "kinetic";

export function motionMode(draft: Pick<Draft, "shine" | "kinetic">): MotionMode {
  return draft.kinetic ? "kinetic" : draft.shine ? "shine" : "none";
}

/** One kind at a time in the sheet: picking one clears the other; "none" clears both. A kind already chosen keeps its preset. */
export function withMotionMode<T extends Pick<Draft, "shine" | "kinetic">>(draft: T, mode: MotionMode): T {
  if (mode === "none") return { ...draft, shine: undefined, kinetic: undefined };
  if (mode === "shine") return { ...draft, kinetic: undefined, shine: draft.shine ?? { preset: "sweep" } };
  return { ...draft, shine: undefined, kinetic: draft.kinetic ?? { preset: "words" } };
}

/** When the chosen motion starts, ms after the text appears (its own or the preset's). */
export function motionStartMs(draft: Pick<Draft, "shine" | "kinetic">): number | null {
  if (draft.kinetic) return draft.kinetic.startMs ?? KINETIC_PRESET[draft.kinetic.preset].startMs;
  if (draft.shine) return draft.shine.startMs ?? SHINE_PRESET[draft.shine.preset].startMs;
  return null;
}

/** Starts the chosen motion at reel time `reelMs`: on a whole frame, inside the text's time. */
export function withMotionStartAt<T extends Pick<Draft, "shine" | "kinetic">>(draft: T, reelMs: number, title: { startMs: number; endMs: number }, fps: number = REEL_FORMAT.fps): T {
  const frame = Math.round(((reelMs - title.startMs) * fps) / 1000);
  const startMs = Math.max(0, Math.min(title.endMs - title.startMs - 1, TYPE_MOTION_START_MAX_MS, Math.round((frame * 1000) / fps)));
  if (draft.kinetic) return { ...draft, kinetic: { ...draft.kinetic, startMs } };
  if (draft.shine) return { ...draft, shine: { ...draft.shine, startMs } };
  return draft;
}

/** The beat nearest the motion's start, not before the text appears; null when the music has no tempo. */
export function beatForMotion(draft: Pick<Draft, "shine" | "kinetic">, title: { startMs: number }, music: Pick<Music, "bpm" | "beatOffsetMs" | "sourceStartMs"> | null | undefined): number | null {
  const start = motionStartMs(draft);
  if (start === null || !music?.bpm || music.beatOffsetMs === null || music.beatOffsetMs === undefined) return null;
  const grid = { bpm: music.bpm, offsetMs: music.beatOffsetMs };
  let beat = nearestBeatMs(title.startMs + start, grid, music.sourceStartMs);
  while (beat < title.startMs) beat += beatPeriodMs(grid);
  return beat;
}

/** A callout's starting look: a small white label (the box style), arriving with its own line. The point is placed by the editor. */
export function asCallout<T extends Draft>(draft: T): T {
  // Not painted on a surface: a label is read on top of the picture (and the surface blend would override its fade).
  return { ...draft, callout: draft.callout ?? { x: 0.4, y: 0.64 }, style: "box", size: 0.6, animation: "auto", blend: undefined };
}
