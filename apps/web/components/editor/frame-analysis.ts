import { clipMomentAtSource, findSurfaceQuad, pickMatchingFrame, trackSampling, trackTitleFromFrames, TRACK_HEIGHT, TRACK_WIDTH, type Clip, type Gray, type TextOverlay, type TrackFailure, type TrackQuality, type TrackTarget, type TrackedTitle } from "@reelwalk/core";
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

/** The video's current frame as luminance at the analysis size, drawn as the composition places its clip (the picture alone, on flat grey). */
export function grayFrame(video: HTMLVideoElement, width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT): Gray {
  scratch ??= document.createElement("canvas");
  scratch.width = width; scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Frame analysis is unavailable in this browser.");
  const clip = presentedAs.get(video);
  if (clip) drawPresented(ctx, video, clip, clipMomentAtSource(clip, video.currentTime * 1000), width, height, "analysis");
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

// The tracker's size and the quality read-out live in core (surface-track.ts), shared with the commands route (ADR 0075).
export { TRACK_HEIGHT, TRACK_WIDTH, type TrackQuality };

type TrackedPath = TrackedTitle;

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
  const sampling = trackSampling(clip, clipStartMs, text);
  if ("error" in sampling) return sampling;
  let video: HTMLVideoElement | null = null;
  try {
    video = await load(asset, clip);
    // Sample the shot evenly from its first to its true last frame (at most 63 samples, at most stepMs apart),
    // so keyframe t lines up with the pin's interval; then track. Reading frames is the slow part.
    const { times } = sampling;
    const frames: Gray[] = [];
    for (const at of times) {
      await seek(video, at);
      frames.push(grayFrame(video, TRACK_WIDTH, TRACK_HEIGHT));
      onProgress?.((0.7 * frames.length) / times.length);
    }
    return await trackTitleFromFrames({ frames, times, assetId: asset.id, clip, clipStartMs, text, lean, onProgress });
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
    const frame = await frameService.frameAt({ clip, media: { src: asset.url, kind: asset.kind } }, Math.min(sourceMs, Math.max(0, clip.sourceEndMs - 40)), { width: TRACK_WIDTH * 2, height: TRACK_HEIGHT * 2, purpose: "analysis" });
    if (!frame) return null;
    const gray = luminance(frame);
    const found = findSurfaceQuad(gray, text.x * gray.width, text.y * gray.height);
    if (!found) return null;
    return { quad: found.quad.map((v, i) => Number((i % 2 === 0 ? v / gray.width : v / gray.height).toFixed(4))), weakest: Math.min(found.sides.left, found.sides.right, found.sides.top, found.sides.bottom) };
  } catch {
    return null;
  }
}
