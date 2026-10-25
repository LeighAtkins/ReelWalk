/**
 * Following a surface through a shot, without a browser (ADR 0075). The
 * editor's Pin (frame-analysis.ts, ADR 0052) reads frames from a <video>;
 * the commands route has only ffmpeg. Everything that is not reading pixels
 * lives here, once, so a title placed by an agent is tracked by the very code
 * a thumb-tap uses:
 *
 * - `trackSampling`: which source times to read for a title's shot (the same
 *   even sampling, at most 63 frames, at most `stepMs` apart);
 * - `presentGray`: a source frame as the composition shows it (fit, zoom and
 *   the camera move at that moment, on flat grey: the "analysis" picture of
 *   ADR 0047), at the tracker's size;
 * - `trackTitleFromFrames`: the tracker, the smoothing and the saved path and
 *   pin, plus the quality read-out the Pin sheet shows.
 */
import { leanQuad, type Gray, type Quad } from "./motion";
import { defaultTolerance, smoothTrack, trackPath, trackSurfaceAsync, type TrackFailure } from "./track";
import { clipMomentAtSource, compositionToSource, clipPicture } from "./view";
import type { Clip, TextOverlay } from "./timeline";

/** A third of 1080×1920: fine enough that a sub-pixel match is under two output pixels. */
export const TRACK_WIDTH = 360;
export const TRACK_HEIGHT = 640;

/** How well a pin followed its surface: what the Pin sheet shows before the user trusts it. */
export type TrackQuality = {
  /** Points with detail found on the surface at the start. */
  points: number;
  /** Mean points agreeing with the plane per measured step. */
  inliers: number;
  /** Steps refused by the gates (held instead of jumping). */
  held: number;
  /** Steps taken. */
  steps: number;
  /** "good" is attached throughout; "weak" held often or had low confidence somewhere; "lost" faded before the end. */
  grade: "good" | "weak" | "lost";
  /** Mean per-frame confidence 0–1 that the plane is on its surface (ADR 0052): coverage of the quad by agreeing points and reprojection error. */
  confidence?: number;
  /** Why the surface was lost, in words, when it was. */
  reason?: string;
};

export type TrackTarget = Pick<TextOverlay, "x" | "y" | "startMs" | "endMs"> & {
  surface?: readonly number[];
  /** Author corrections: the right corners (frame fractions, the surface's corner order) at a composition time; the track re-runs outward from each (ADR 0052). */
  corrections?: readonly { atMs: number; quad: readonly number[] }[];
  /** A wider area on the same plane (frame fractions) to take features from instead of the surface itself, opt-in (ADR 0052): a title that fills part of a larger wall is followed by the whole wall (ADR 0075). Not saved. */
  support?: readonly number[];
};

export type TrackedTitle = { path: NonNullable<TextOverlay["path"]>; pin: NonNullable<TextOverlay["pin"]>; lostAtMs: number | null; quality: TrackQuality; confidence: number[] };

export type TrackSampling = { fromMs: number; toMs: number; stepMs: number; times: number[] };

/**
 * The source times to read to track `text` through the clip it starts on: from the title's first source
 * frame to its true last one, evenly, at most 63 samples and at most `stepMs` (100 ms or a sixtieth of the shot) apart,
 * so keyframe t lines up with the pin's interval. An error in words when the title is on screen too briefly.
 */
export function trackSampling(clip: Pick<Clip, "speed" | "sourceStartMs" | "sourceEndMs">, clipStartMs: number, text: Pick<TextOverlay, "startMs" | "endMs">): TrackSampling | { error: string } {
  const speed = clip.speed || 1;
  const lifeMs = text.endMs - text.startMs;
  const firstSource = clip.sourceStartMs + Math.max(0, text.startMs - clipStartMs) * speed;
  const lastSource = Math.min(clip.sourceEndMs, clip.sourceStartMs + Math.max(0, text.endMs - clipStartMs) * speed);
  if (lastSource - firstSource < 200 || lifeMs <= 0) return { error: "This title is on screen too briefly to track." };
  const stepMs = Math.max(100, (lastSource - firstSource) / 60);
  const fromMs = Math.round(firstSource), toMs = Math.round(lastSource);
  const count = Math.min(63, Math.max(2, Math.ceil((toMs - fromMs) / stepMs) + 1));
  return { fromMs, toMs, stepMs, times: Array.from({ length: count }, (_, i) => fromMs + ((toMs - fromMs) * i) / (count - 1)) };
}

const bilinear = (src: Gray, x: number, y: number): number => {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number) => src.data[Math.min(src.height - 1, Math.max(0, yy)) * src.width + Math.min(src.width - 1, Math.max(0, xx))];
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
};

/**
 * A source frame as the composition shows it at `sourceMs`, on flat grey where the picture does not reach: the
 * picture alone through the clip's fit, zoom and eased camera move or preset (the analysis picture, ADR 0047,
 * what the browser draws with `drawClipFrame`), `width`×`height` luminance. `source` is the decoded frame at any
 * resolution (the mapping is in fractions of it).
 */
export function presentGray(source: Gray, clip: Pick<Clip, "kind" | "fit" | "zoom" | "motion" | "camera" | "speed" | "sourceStartMs" | "sourceEndMs" | "ramp">, sourceMs: number, width = TRACK_WIDTH, height = TRACK_HEIGHT, fill = 128): Gray {
  const picture = clipPicture(clip, { width: source.width, height: source.height }, clipMomentAtSource(clip as Clip, sourceMs));
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [sx, sy] = compositionToSource(picture, (x + 0.5) / width, (y + 0.5) / height);
    data[y * width + x] = sx < 0 || sy < 0 || sx > source.width - 1 || sy > source.height - 1 ? fill : bilinear(source, sx - 0.5, sy - 0.5);
  }
  return { data, width, height };
}

/**
 * Follow the surface under `text` through `frames` (composition frames at the sampled `times`, tracker size) and
 * return the pin and path to save, with the Pin sheet's quality read-out, or the tracker's reason for refusing
 * ("Could not follow this surface: ..."). The plane is the title's `surface` or, without one, a box around it
 * turned and tilted by `lean`. `text.support` is a wider area on the same plane to take features from (opt-in, ADR 0052):
 * a title that fills a part of a larger wall is followed by the whole wall.
 */
export async function trackTitleFromFrames(input: {
  frames: Gray[]; times: number[]; assetId: string; clip: Pick<Clip, "speed" | "sourceStartMs" | "sourceEndMs">; clipStartMs: number;
  text: TrackTarget; lean?: { yaw: number; pitch: number }; onProgress?(fraction: number): void;
}): Promise<TrackedTitle | { error: string; reason?: TrackFailure }> {
  const { frames, times, clip, clipStartMs, text, assetId } = input;
  const lean = input.lean ?? { yaw: 0, pitch: 0 };
  const speed = clip.speed || 1;
  const fromMs = Math.round(times[0]), toMs = Math.round(times[times.length - 1]);
  const toPx = (q: readonly number[]) => q.map((v, i) => (i % 2 === 0 ? v * TRACK_WIDTH : v * TRACK_HEIGHT)) as Quad;
  const toFraction = (q: readonly number[]) => q.map((v, i) => (i % 2 === 0 ? v / TRACK_WIDTH : v / TRACK_HEIGHT)) as Quad;
  // The plane is the surface the author chose (its own perspective), or a box around the text turned and tilted like the wall.
  const surface = text.surface && text.surface.length === 8 ? toPx(text.surface) : null;
  const margin = Math.round(TRACK_WIDTH * 0.03) + 1;
  const hw = TRACK_WIDTH * 0.2, hh = TRACK_HEIGHT * 0.075;
  const cx = Math.max(margin + hw, Math.min(TRACK_WIDTH - 1 - margin - hw, text.x * TRACK_WIDTH)), cy = Math.max(margin + hh, Math.min(TRACK_HEIGHT - 1 - margin - hh, text.y * TRACK_HEIGHT));
  const flat: Quad = [cx - hw, cy - hh, cx + hw, cy - hh, cx + hw, cy + hh, cx - hw, cy + hh];
  const quad0: Quad = surface ?? toPx(leanQuad(toFraction(flat), lean.yaw, lean.pitch));
  const nearest = (sourceMs: number) => times.reduce((best, t, i) => (Math.abs(t - sourceMs) < Math.abs(times[best] - sourceMs) ? i : best), 0);
  const anchors = [{ index: 0, quad: quad0 }, ...(text.corrections ?? []).filter((c) => c.quad.length === 8).map((c) => ({ index: nearest(clip.sourceStartMs + (c.atMs - clipStartMs) * speed), quad: toPx(c.quad) }))];
  // Hands the thread back between frame steps so progress paints and the editor stays responsive; same result as trackSurface.
  const result = await trackSurfaceAsync(frames, anchors, { onProgress: (f) => input.onProgress?.(0.7 + 0.3 * f), ...(text.support && text.support.length === 8 ? { support: toPx(text.support) } : {}) });
  if (!result.ok) return { error: result.message, reason: result.reason };
  // Smoothed within measured runs, each frame moved at most max(5 × its uncertainty, the inlier tolerance); anchors stay exact.
  // Lost frames are hidden (o = 0) and carry the nearest measured corners, so nothing stale fades in (ADR 0052).
  const { path, confidence: perKeyframe } = trackPath(smoothTrack(result.frames, { floorPx: defaultTolerance(TRACK_WIDTH) }), times, { fromMs, toMs }, text, { width: TRACK_WIDTH, height: TRACK_HEIGHT });
  const measured = result.frames.filter((f) => !f.anchor && !f.lost);
  const confidence = measured.length ? measured.reduce((sum, f) => sum + f.confidence, 0) / measured.length : 0;
  const lostAtMs = result.lostAt !== null ? Math.round(times[result.lostAt]) : null;
  const quality: TrackQuality = {
    points: result.stats.points, inliers: Math.round(result.stats.meanInliers), held: result.stats.held, steps: result.stats.steps,
    grade: lostAtMs !== null ? "lost" : result.stats.held > result.stats.steps * 0.15 || confidence < 0.5 || measured.some((f) => f.confidence < 0.25) ? "weak" : "good",
    confidence: Number(confidence.toFixed(2)),
    ...(result.message ? { reason: result.message } : {}),
  };
  return {
    path,
    pin: { assetId, fromMs, toMs, quad: toFraction(quad0).map((v) => Number(v.toFixed(4))), ...(!surface && (lean.yaw || lean.pitch) ? { lean } : {}) },
    lostAtMs, quality,
    confidence: perKeyframe,
  };
}
