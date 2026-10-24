import type React from "react";
import { interpolate } from "remotion";
import { clipCameraAt, speedPlanOf, type Clip } from "@reelwalk/core";
import { whipGeometry } from "./whip";

/** Frames of the dip-to-black on each side of a "fade" transition. */
export const FADE_FRAMES = 8;
/** Four silent frames on either side of a deliberate camera-matched whip. */
export const WHIP_FRAMES = 4;

export function whipStyle(amount: number, filterId: string, direction: Clip["whipDirection"]): React.CSSProperties | undefined {
  if (amount === 0) return undefined;
  const g = whipGeometry(amount, direction);
  return { transform: `translate(${g.x}%, ${g.y}%) scale(${g.scaleX}, ${g.scaleY})`, filter: `url(#${filterId})` };
}

/** The camera move (eased keys, or the Ken Burns preset) and the clip's own zoom, as one CSS transform about the centre. */
export function motionTransform(clip: Pick<Clip, "motion" | "camera" | "zoom">, progress: number, seconds: number, opening = false): string | undefined {
  const move = clipCameraAt(clip, progress, seconds, opening);
  const zoom = clip.zoom || 1;
  if (zoom === 1 && move.scale === 1 && move.x === 0 && move.y === 0) return undefined;
  return move.y === 0 ? `scale(${zoom * move.scale}) translateX(${move.x}%)` : `scale(${zoom * move.scale}) translate(${move.x}%, ${move.y}%)`;
}

export type ClipPresentation = {
  /** The fade-in and fade-out of a "fade" transition, multiplied. */
  opacity: number;
  /** Zoom and camera move, applied to the picture inside the frame. */
  transform: string | undefined;
  /** The whip's displacement and blur, applied to the whole frame; undefined when not whipping. */
  whip: React.CSSProperties | undefined;
  whipAmount: number;
  whipId: string;
  whipDirection: Clip["whipDirection"] | undefined;
  /** The speed-ramp transition's directional blur (ADR 0073): σ in px along each axis, with the filter's id; null when not blurring. Its style is in `whip` when no whip is drawn. */
  speedBlur: { id: string; x: number; y: number } | null;
};

/** Blur σ under this (px at 1080 wide) is not drawn. */
const BLUR_MIN_PX = 0.4;

/**
 * How a clip is shown at `frame`: its fade, its motion and its whip. One
 * function for the footage and for the person matte drawn above the type, so
 * the matte always sits exactly on the body it was cut from (review of
 * 2026-10-20: the matte used to ignore zoom, fit and transitions).
 */
export function clipPresentation(clip: Clip, frame: number, fps: number, durationInFrames: number, fadeOut: boolean, whipOut: Clip["whipDirection"] | null, opening = false): ClipPresentation {
  // Clamped: a clip is mounted a second early (premount) with negative frames.
  const progress = durationInFrames > 1 ? Math.min(1, Math.max(0, frame / (durationInFrames - 1))) : 0;
  const motion = motionTransform(clip, progress, Math.max(0, frame / fps), opening);
  // The speed-ramp transition (ADR 0073): a push-in and a directional blur that follow the clip's speed on its ramp frames.
  const plan = speedPlanOf(clip);
  const planned = plan ? Math.min(plan.frames - 1, Math.max(0, Math.round(frame))) : 0;
  const push = plan ? plan.push[planned] : 0;
  const transform = push > 0 ? `scale(${1 + push})${motion ? ` ${motion}` : ""}` : motion;
  const fadeIn = clip.transitionIn === "fade" ? interpolate(frame, [0, FADE_FRAMES], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const fadeOutValue = fadeOut
    ? interpolate(frame, [durationInFrames - FADE_FRAMES, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const whipIn = clip.transitionIn === "whip" ? interpolate(frame, [0, WHIP_FRAMES], [1, 0], clamp) : 0;
  const whipAway = whipOut ? interpolate(frame, [durationInFrames - WHIP_FRAMES, durationInFrames - 1], [0, -1], clamp) : 0;
  const whipAmount = whipIn || whipAway;
  const whipId = `whip-${clip.id}`;
  const whipDirection = whipIn ? clip.whipDirection : whipOut ?? undefined;
  const blurX = plan ? plan.blurX[planned] : 0, blurY = plan ? plan.blurY[planned] : 0;
  const speedBlur = blurX >= BLUR_MIN_PX || blurY >= BLUR_MIN_PX ? { id: `speedblur-${clip.id}`, x: blurX, y: blurY } : null;
  // A whip on the same frame wins (a clip too short for both); the blur is otherwise drawn the way a whip's is.
  const whip = whipStyle(whipAmount, whipId, whipDirection) ?? (speedBlur ? ({ filter: `url(#${speedBlur.id})` } as React.CSSProperties) : undefined);
  return { opacity: Math.min(fadeIn, fadeOutValue), transform, whip, whipAmount, whipId, whipDirection, speedBlur: whipAmount === 0 ? speedBlur : null };
}

/**
 * Where a video lands in a frame under `object-fit`. Moved to
 * `@reelwalk/core` view.ts (ADR 0047) so analysis, the editor's handles and
 * the composition share one implementation; re-exported here unchanged.
 */
export { fitRects } from "@reelwalk/core";
