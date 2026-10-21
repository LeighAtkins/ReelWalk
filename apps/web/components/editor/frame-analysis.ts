import { clipMomentAtSource, defaultTolerance, findSurfaceQuad, leanQuad, pickMatchingFrame, smoothTrack, trackPath, trackSurfaceAsync, type Clip, type Gray, type Quad, type TextOverlay, type TrackFailure } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { drawPresented, frameService, loadVideo, luminance, releaseVideo, seekVideo } from "./frame-service";

/**
 * Browser side of @reelwalk/core's motion module: small grayscale frames from
 * a video element. A video opened for a clip is read through the clip's
 * presentation (ADR 0047), so the analysis works in composition fractions,
 * the space text x/y and surfaces are stored in, for any fit, zoom or move.
 */

export const ANALYSIS_WIDTH = 48;
export const ANALYSIS_HEIGHT = 85;

let scratch: HTMLCanvasElement | null = null;
/** The clip each analysis video is presented as; a video without one is read whole (frame matching compares raw sources). */
const presentedAs = new WeakMap<HTMLVideoElement, Clip>();

/** The video's current frame as luminance at the analysis size, drawn as the composition shows its clip. */
export function grayFrame(video: HTMLVideoElement, width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT): Gray {
  scratch ??= document.createElement("canvas");
  scratch.width = width; scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Frame analysis is unavailable in this browser.");
  const clip = presentedAs.get(video);
  if (clip) drawPresented(ctx, video, clip, clipMomentAtSource(clip, video.currentTime * 1000), width, height);
  else ctx.drawImage(video, 0, 0, width, height);
  return luminance(scratch);
}

const seek = seekVideo;

/** Opens the asset's video; given the clip it plays in, frames read from it are that clip's composition frames. */
async function load(asset: LibraryAsset, clip?: Clip): Promise<HTMLVideoElement> {
  const video = await loadVideo(asset.url, asset.fileName);
  if (clip) presentedAs.set(video, clip);
  return video;
}

// A third of 1080×1920: fine enough that a sub-pixel match is under two output pixels.
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

type TrackTarget = Pick<TextOverlay, "x" | "y" | "startMs" | "endMs"> & {
  surface?: readonly number[];
  /** Author corrections: the right corners (frame fractions, the surface's corner order) at a composition time; the track re-runs outward from each (ADR 0052). */
  corrections?: readonly { atMs: number; quad: readonly number[] }[];
};

type TrackedPath = { path: NonNullable<TextOverlay["path"]>; pin: NonNullable<TextOverlay["pin"]>; lostAtMs: number | null; quality: TrackQuality; confidence: number[] };

/**
 * Pin a text to the picture (ADR 0039, 0052): follow the surface under it
 * through the clip it starts on and return a path of position, scale,
 * rotation and corner keyframes over the text's lifetime. Null when the
 * surface could not be followed; `trackTextPathDetailed` says why.
 */
export async function trackTextPath(
  asset: LibraryAsset, clip: Clip, clipStartMs: number, text: TrackTarget,
  onProgress?: (fraction: number) => void,
  /** Turn and tilt of the plane into the wall's perspective, degrees; ignored when the text has a surface. */
  lean: { yaw: number; pitch: number } = { yaw: 0, pitch: 0 },
): Promise<TrackedPath | null> {
  const tracked = await trackTextPathDetailed(asset, clip, clipStartMs, text, onProgress, lean);
  return "error" in tracked ? null : tracked;
}

/**
 * The tracker behind Pin (ADR 0052): samples the shot, then
 * `@reelwalk/core`'s `trackSurface` follows the plane from features inside
 * the surface only (never borrowed from around it), and either returns the
 * path with a confidence per keyframe or a reason it refused ("Could not
 * follow this surface: ..."). If the surface is lost (it left the frame, or
 * something covered it) the title fades out over one sample at its last
 * measured corners and stays hidden; it fades back in at the re-found
 * corners if the tracker finds the surface again.
 */
export async function trackTextPathDetailed(
  asset: LibraryAsset, clip: Clip, clipStartMs: number, text: TrackTarget,
  onProgress?: (fraction: number) => void,
  lean: { yaw: number; pitch: number } = { yaw: 0, pitch: 0 },
): Promise<TrackedPath | { error: string; reason?: TrackFailure }> {
  const speed = clip.speed || 1;
  const lifeMs = text.endMs - text.startMs;
  const firstSource = clip.sourceStartMs + Math.max(0, text.startMs - clipStartMs) * speed;
  const lastSource = Math.min(clip.sourceEndMs, clip.sourceStartMs + Math.max(0, text.endMs - clipStartMs) * speed);
  if (lastSource - firstSource < 200 || lifeMs <= 0) return { error: "This title is on screen too briefly to track." };
  const stepMs = Math.max(100, (lastSource - firstSource) / 60);
  const toPx = (q: readonly number[]) => q.map((v, i) => (i % 2 === 0 ? v * TRACK_WIDTH : v * TRACK_HEIGHT)) as Quad;
  const toFraction = (q: readonly number[]) => q.map((v, i) => (i % 2 === 0 ? v / TRACK_WIDTH : v / TRACK_HEIGHT)) as Quad;
  // The plane is the surface the author chose (its own perspective), or a box around the text turned and tilted like the wall.
  const surface = text.surface && text.surface.length === 8 ? toPx(text.surface) : null;
  const margin = Math.round(TRACK_WIDTH * 0.03) + 1;
  const hw = TRACK_WIDTH * 0.2, hh = TRACK_HEIGHT * 0.075;
  const cx = Math.max(margin + hw, Math.min(TRACK_WIDTH - 1 - margin - hw, text.x * TRACK_WIDTH)), cy = Math.max(margin + hh, Math.min(TRACK_HEIGHT - 1 - margin - hh, text.y * TRACK_HEIGHT));
  const flat: Quad = [cx - hw, cy - hh, cx + hw, cy - hh, cx + hw, cy + hh, cx - hw, cy + hh];
  const quad0: Quad = surface ?? toPx(leanQuad(toFraction(flat), lean.yaw, lean.pitch));
  let video: HTMLVideoElement | null = null;
  try {
    video = await load(asset, clip);
    // Sample the shot evenly from its first to its true last frame (at most 63 samples, at most stepMs apart),
    // so keyframe t lines up with the pin's interval; then track. Reading frames is the slow part.
    const fromMs = Math.round(firstSource), toMs = Math.round(lastSource);
    const count = Math.min(63, Math.max(2, Math.ceil((toMs - fromMs) / stepMs) + 1));
    const times = Array.from({ length: count }, (_, i) => fromMs + ((toMs - fromMs) * i) / (count - 1));
    const frames: Gray[] = [];
    for (const at of times) {
      await seek(video, at);
      frames.push(grayFrame(video, TRACK_WIDTH, TRACK_HEIGHT));
      onProgress?.((0.7 * frames.length) / times.length);
    }
    const nearest = (sourceMs: number) => times.reduce((best, t, i) => (Math.abs(t - sourceMs) < Math.abs(times[best] - sourceMs) ? i : best), 0);
    const anchors = [{ index: 0, quad: quad0 }, ...(text.corrections ?? []).filter((c) => c.quad.length === 8).map((c) => ({ index: nearest(clip.sourceStartMs + (c.atMs - clipStartMs) * speed), quad: toPx(c.quad) }))];
    // Hands the thread back between frame steps so progress paints and the editor stays responsive; same result as trackSurface.
    const result = await trackSurfaceAsync(frames, anchors, { onProgress: (f) => onProgress?.(0.7 + 0.3 * f) });
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
      pin: { assetId: asset.id, fromMs, toMs, quad: toFraction(quad0).map((v) => Number(v.toFixed(4))), ...(!surface && (lean.yaw || lean.pitch) ? { lean } : {}) },
      lostAtMs, quality,
      confidence: perKeyframe,
    };
  } catch {
    return { error: "The video could not be read." };
  } finally {
    if (video) releaseVideo(video);
  }
}

/**
 * Where to end `from` so it cuts cleanly into `to`: the frame in the last
 * `windowMs` of `from`'s played window that most resembles `to`'s first
 * played frame. Returns the source end time in ms, and whether it is a
 * close match. Null when either video cannot be read.
 */
export async function findMatchingCut(
  from: { asset: LibraryAsset; sourceStartMs: number; sourceEndMs: number },
  to: { asset: LibraryAsset; sourceStartMs: number },
  { windowMs = 1500, stepMs = 1000 / 24 }: { windowMs?: number; stepMs?: number } = {},
): Promise<{ sourceEndMs: number; close: boolean } | null> {
  let a: HTMLVideoElement | null = null, b: HTMLVideoElement | null = null;
  try {
    [a, b] = await Promise.all([load(from.asset), load(to.asset)]);
    await seek(b, Math.min(to.sourceStartMs, b.duration * 1000 - 40));
    const target = grayFrame(b);
    const last = Math.min(from.sourceEndMs, a.duration * 1000 - 40);
    const first = Math.max(from.sourceStartMs + 300, last - windowMs);
    const candidates: { t: number; gray: Gray }[] = [];
    for (let t = first; t <= last; t += stepMs) {
      await seek(a, t);
      candidates.push({ t: Math.round(t), gray: grayFrame(a) });
    }
    const pick = pickMatchingFrame(candidates, target);
    return pick ? { sourceEndMs: pick.t, close: pick.close } : null;
  } catch {
    return null;
  } finally {
    for (const video of [a, b]) if (video) releaseVideo(video);
  }
}

/**
 * The flat surface under a text at the frame it starts on (ADR 0043): the
 * strongest edges left, right, above and below it, as four corners in
 * composition fractions, or null when the picture has no usable edges there.
 * Reads the frame the composition shows (ADR 0047), so landscape footage
 * under Fill or Fit is measured where it is on screen, not stretched.
 */
export async function detectSurface(asset: LibraryAsset, clip: Clip, clipStartMs: number, text: Pick<TextOverlay, "x" | "y" | "startMs">): Promise<{ quad: number[]; weakest: number } | null> {
  const speed = clip.speed || 1;
  const sourceMs = clip.sourceStartMs + Math.max(0, text.startMs - clipStartMs) * speed;
  try {
    const frame = await frameService.frameAt({ clip, media: { src: asset.url, kind: asset.kind } }, Math.min(sourceMs, Math.max(0, clip.sourceEndMs - 40)), TRACK_WIDTH * 2, TRACK_HEIGHT * 2);
    if (!frame) return null;
    const gray = luminance(frame);
    const found = findSurfaceQuad(gray, text.x * gray.width, text.y * gray.height);
    if (!found) return null;
    return { quad: found.quad.map((v, i) => Number((i % 2 === 0 ? v / gray.width : v / gray.height).toFixed(4))), weakest: Math.min(found.sides.left, found.sides.right, found.sides.top, found.sides.bottom) };
  } catch {
    return null;
  }
}
