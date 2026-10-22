/**
 * Frame-exact cuts (ADR 0067): the one place reel milliseconds become frames
 * and a clip's source window becomes what the media element is asked to play.
 *
 * The composition's `Sequence` for a clip runs from `framePlan`'s rounded
 * start for its rounded length; the media inside must have a frame for every
 * one of those frames. Before this module the media trimmed itself on its own
 * rounding of `sourceStartMs` and `sourceEndMs`, which could be one frame
 * shorter than the sequence, so a cut 20–30 ms off a frame boundary showed
 * one frame of nothing (black, titles still drawn) just before the cut. Now
 * the window is derived from the sequence length, never from the end time.
 */
import { rampGain, rampSpeedAt, rampWarp } from "./ramp";
import { REEL_FORMAT, type Clip } from "./timeline";

/** Reel (or source) milliseconds to a whole frame, the way the composition cuts. */
export function msToFrame(ms: number, fps: number = REEL_FORMAT.fps): number {
  return Math.round((ms * fps) / 1000);
}

const speedOf = (clip: Pick<Clip, "kind" | "speed">) => (clip.kind === "IMAGE" ? 1 : clip.speed || 1);

/**
 * The source frame (fractional) the clip shows at `frameInClip` of its
 * `durationInFrames`: the media's whole-frame start plus the frames played so
 * far, warped by the ramp when it has one. Frames before 0 (a premounted clip)
 * read as frame 0.
 */
export function clipSourceFrame(clip: Pick<Clip, "kind" | "speed" | "sourceStartMs" | "ramp">, frameInClip: number, durationInFrames: number, fps: number = REEL_FORMAT.fps): number {
  const trimBefore = msToFrame(clip.sourceStartMs, fps);
  const speed = speedOf(clip);
  const f = Math.max(0, frameInClip);
  const ramp = clip.kind === "IMAGE" ? null : clip.ramp;
  if (!ramp) return trimBefore + f * speed;
  const length = Math.max(1, durationInFrames);
  return trimBefore + rampWarp(ramp, f / length) * length * speed;
}

export type MediaWindow = {
  /** Whole source frame the media starts at. */
  trimBefore: number;
  /** Past the last frame the sequence can ask for, so the media never runs out before the cut. */
  trimAfter: number;
  /** The rate that puts the media on `clipSourceFrame` at this frame: the clip's speed, or the ramp's mean rate so far. */
  playbackRate: number;
  /** How loud the clip's own sound plays at this frame (1 without a ramp). */
  gain: number;
};

/**
 * What the media element is asked to play at `frameInClip`. The window always
 * covers the whole sequence: `(trimAfter − trimBefore) / playbackRate ≥
 * durationInFrames`, so no frame of the sequence is ever without a picture.
 *
 * With a ramp the rate is the mean rate from the clip's first frame to this
 * one, because a media element reads its time as `trimBefore + frame × rate`:
 * that lands every rendered frame exactly on `clipSourceFrame`. In the
 * editor's playing preview the element runs at that mean rate and is pulled
 * back onto the curve by the player's drift check; paused frames are exact.
 */
export function mediaWindow(clip: Pick<Clip, "kind" | "speed" | "sourceStartMs" | "ramp">, frameInClip: number, durationInFrames: number, fps: number = REEL_FORMAT.fps): MediaWindow {
  const trimBefore = msToFrame(clip.sourceStartMs, fps);
  const speed = speedOf(clip);
  const length = Math.max(1, durationInFrames);
  const ramp = clip.kind === "IMAGE" ? null : clip.ramp;
  const trimAfter = trimBefore + length * speed + 1;
  if (!ramp) return { trimBefore, trimAfter, playbackRate: speed, gain: 1 };
  const f = Math.max(0, frameInClip);
  const source = clipSourceFrame(clip, f, length, fps);
  const playbackRate = f > 0 ? (source - trimBefore) / f : speed * rampSpeedAt(ramp, 0);
  return { trimBefore, trimAfter, playbackRate: Math.max(0.0625, playbackRate), gain: rampGain(rampSpeedAt(ramp, f / length)) };
}

/** True when the media window leaves a frame of the sequence without a picture (the regression this module exists for). */
export function windowShortOfSequence(window: MediaWindow, durationInFrames: number): boolean {
  return (window.trimAfter - window.trimBefore) / window.playbackRate < durationInFrames;
}
