import { interpolate } from "remotion";
import { clipCameraAt, type Clip } from "@reelwalk/core";

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
};

/**
 * How a clip is shown at `frame`: its opening fade and its motion. One function for the footage and for the person
 * matte drawn above the type, so the matte always sits exactly on the body it was cut from (review of 2026-10-20: the
 * matte used to ignore zoom, fit and transitions). The speed-ramp transition's push and blur that were drawn here went
 * with that kind (ADR 0082).
 */
export function clipPresentation(clip: Clip, frame: number, fps: number, durationInFrames: number, opening = false): ClipPresentation {
  // Clamped: a clip is mounted a second early (premount) with negative frames.
  const progress = durationInFrames > 1 ? Math.min(1, Math.max(0, frame / (durationInFrames - 1))) : 0;
  const transform = motionTransform(clip, progress, Math.max(0, frame / fps), opening);
  // The reel's first shot has no shot before it to cross from: its "fade" is a fade up from black.
  const fadeIn = opening && clip.transitionIn === "fade" ? interpolate(frame, [0, FADE_FRAMES], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  return { opacity: fadeIn, transform };
}

/**
 * Where a video lands in a frame under `object-fit`. Moved to
 * `@reelwalk/core` view.ts (ADR 0047) so analysis, the editor's handles and
 * the composition share one implementation; re-exported here unchanged.
 */
export { fitRects } from "@reelwalk/core";
