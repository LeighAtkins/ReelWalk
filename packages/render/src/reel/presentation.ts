import type React from "react";
import { interpolate } from "remotion";
import { cameraMoveAt, type Clip } from "@reelwalk/core";
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

/** The Ken Burns move and the clip's own zoom, as one CSS transform about the centre. */
export function motionTransform(motion: Clip["motion"], progress: number, zoom: number, seconds: number): string | undefined {
  const move = cameraMoveAt(motion, progress, seconds);
  return zoom === 1 && move.scale === 1 && move.x === 0 ? undefined : `scale(${zoom * move.scale}) translateX(${move.x}%)`;
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
export function clipPresentation(clip: Clip, frame: number, fps: number, durationInFrames: number, fadeOut: boolean, whipOut: Clip["whipDirection"] | null): ClipPresentation {
  // Clamped: a clip is mounted a second early (premount) with negative frames.
  const progress = durationInFrames > 1 ? Math.min(1, Math.max(0, frame / (durationInFrames - 1))) : 0;
  const transform = motionTransform(clip.motion, progress, clip.zoom, Math.max(0, frame / fps));
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
 * Where a video of `sourceWidth`×`sourceHeight` lands in a `width`×`height`
 * frame under `object-fit`, as the source rectangle to draw and the
 * destination rectangle to draw it into. The matte draws the person through
 * the same geometry as the footage, so neither is stretched.
 */
export function fitRects(sourceWidth: number, sourceHeight: number, width: number, height: number, fit: "cover" | "contain"): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const scale = fit === "cover" ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight);
  const dw = sourceWidth * scale, dh = sourceHeight * scale;
  if (fit === "cover") {
    const sw = width / scale, sh = height / scale;
    return { sx: (sourceWidth - sw) / 2, sy: (sourceHeight - sh) / 2, sw, sh, dx: 0, dy: 0, dw: width, dh: height };
  }
  return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh };
}
