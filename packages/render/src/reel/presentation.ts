import type React from "react";
import { interpolate } from "remotion";
import { clipCameraAt, type Clip } from "@reelwalk/core";
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
};

/**
 * How a clip is shown at `frame`: its fade, its motion and its whip. One
 * function for the footage and for the person matte drawn above the type, so
 * the matte always sits exactly on the body it was cut from (review of
 * 2026-10-20: the matte used to ignore zoom, fit and transitions).
 */
export function clipPresentation(clip: Clip, frame: number, fps: number, durationInFrames: number, fadeOut: boolean, whipOut: Clip["whipDirection"] | null, opening = false): ClipPresentation {
  // Clamped: a clip is mounted a second early (premount) with negative frames.
  const progress = durationInFrames > 1 ? Math.min(1, Math.max(0, frame / (durationInFrames - 1))) : 0;
  const transform = motionTransform(clip, progress, Math.max(0, frame / fps), opening);
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
  return { opacity: Math.min(fadeIn, fadeOutValue), transform, whip: whipStyle(whipAmount, whipId, whipDirection), whipAmount, whipId, whipDirection };
}

/**
 * Where a video lands in a frame under `object-fit`. Moved to
 * `@reelwalk/core` view.ts (ADR 0047) so analysis, the editor's handles and
 * the composition share one implementation; re-exported here unchanged.
 */
export { fitRects } from "@reelwalk/core";
