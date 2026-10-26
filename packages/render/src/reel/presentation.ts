import type React from "react";
import { interpolate } from "remotion";
import { clipCameraAt, speedPlanOf, type Clip } from "@reelwalk/core";
import { roundFocus, zoomBlurStageCount, zoomStageId } from "./zoom-blur";

/** Frames of the fade from black when the reel's opening shot has transitionIn "fade" (every other fade is a TransitionSeries crossfade, ADR 0083). */
export const FADE_FRAMES = 8;

/** The camera move (eased keys, or the Ken Burns preset) and the clip's own zoom, as one CSS transform about the centre. */
export function motionTransform(clip: Pick<Clip, "motion" | "camera" | "zoom">, progress: number, seconds: number, opening = false): string | undefined {
  const move = clipCameraAt(clip, progress, seconds, opening);
  const zoom = clip.zoom || 1;
  if (zoom === 1 && move.scale === 1 && move.x === 0 && move.y === 0) return undefined;
  return move.y === 0 ? `scale(${zoom * move.scale}) translateX(${move.x}%)` : `scale(${zoom * move.scale}) translate(${move.x}%, ${move.y}%)`;
}

export type ClipPresentation = {
  /** The opening shot's fade from black; 1 everywhere else (the transitions between shots are TransitionSeries', ADR 0083). */
  opacity: number;
  /** Zoom and camera move, applied to the picture inside the frame. */
  transform: string | undefined;
  /** The speed-ramp blur's CSS filter over the whole frame (ADR 0073/0074); undefined when not blurring. */
  blur: React.CSSProperties | undefined;
  /**
   * The speed-ramp transition's blur (ADR 0073): σ in px along each axis, or (ADR 0074) a zoom blur's spread (how much
   * larger its outermost copy is) streaking from the focus (frame fractions); with the filter's id. Null when not blurring.
   */
  speedBlur: { id: string; x: number; y: number; zoom: number; fx: number; fy: number } | null;
};

/** The CSS filter of a speed-ramp blur: one reference for the Gaussian, one per stage for the zoom blur (chained, so each stage reads the one before as a finished layer). */
export function speedBlurFilter(blur: { id: string; zoom: number }): string {
  if (blur.zoom <= 0) return `url(#${blur.id})`;
  return Array.from({ length: zoomBlurStageCount(blur.zoom) }, (_, s) => `url(#${zoomStageId(blur.id, s)})`).join(" ");
}

/** Blur σ under this (px at 1080 wide) is not drawn. */
const BLUR_MIN_PX = 0.4;
/** A zoom blur's spread under this (a 0.4 % larger outer copy: about two px at the edge) is not drawn. */
const ZOOM_MIN = 0.004;

/**
 * How a clip is shown at `frame`: its opening fade, its motion and its speed-ramp blur. One
 * function for the footage and for the person matte drawn above the type, so
 * the matte always sits exactly on the body it was cut from (review of
 * 2026-10-20: the matte used to ignore zoom, fit and transitions).
 */
export function clipPresentation(clip: Clip, frame: number, fps: number, durationInFrames: number, opening = false): ClipPresentation {
  // Clamped: a clip is mounted a second early (premount) with negative frames.
  const progress = durationInFrames > 1 ? Math.min(1, Math.max(0, frame / (durationInFrames - 1))) : 0;
  const motion = motionTransform(clip, progress, Math.max(0, frame / fps), opening);
  // The speed-ramp transition (ADR 0073): a push-in and a directional blur that follow the clip's speed on its ramp frames.
  const plan = speedPlanOf(clip);
  const planned = plan ? Math.min(plan.frames - 1, Math.max(0, Math.round(frame))) : 0;
  const push = plan ? plan.push[planned] : 0;
  const zoomSpread = plan?.zoom?.[planned] ?? 0;
  const focusX = roundFocus(plan?.focusX?.[planned] ?? 0.5), focusY = roundFocus(plan?.focusY?.[planned] ?? 0.5);
  // The push grows about the zoom blur's focus when it has one (a forward move expands from its vanishing point),
  // so the blur's streaks and the push's growth radiate from the same place and reinforce each other.
  const about = zoomSpread >= ZOOM_MIN && (focusX !== 0.5 || focusY !== 0.5) ? { x: Math.round((focusX - 0.5) * 10000) / 100, y: Math.round((focusY - 0.5) * 10000) / 100 } : null;
  const pushed = about ? `translate(${about.x}%, ${about.y}%) scale(${1 + push}) translate(${-about.x}%, ${-about.y}%)` : `scale(${1 + push})`;
  const transform = push > 0 ? `${pushed}${motion ? ` ${motion}` : ""}` : motion;
  // The reel's first shot has no shot before it to cross from: its "fade" is a fade up from black.
  const fadeIn = opening && clip.transitionIn === "fade" ? interpolate(frame, [0, FADE_FRAMES], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const blurX = plan ? plan.blurX[planned] : 0, blurY = plan ? plan.blurY[planned] : 0;
  const speedBlur = blurX >= BLUR_MIN_PX || blurY >= BLUR_MIN_PX || zoomSpread >= ZOOM_MIN ? { id: `speedblur-${clip.id}`, x: blurX, y: blurY, zoom: zoomSpread >= ZOOM_MIN ? zoomSpread : 0, fx: focusX, fy: focusY } : null;
  return { opacity: fadeIn, transform, blur: speedBlur ? { filter: speedBlurFilter(speedBlur) } : undefined, speedBlur };
}

/**
 * Where a video lands in a frame under `object-fit`. Moved to
 * `@reelwalk/core` view.ts (ADR 0047) so analysis, the editor's handles and
 * the composition share one implementation; re-exported here unchanged.
 */
export { fitRects } from "@reelwalk/core";
