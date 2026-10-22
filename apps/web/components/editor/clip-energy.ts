import { summariseMotion, type ClipMotion, type Gray, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { grayFrame } from "./frame-analysis";
import { loadVideo, releaseVideo, seekVideo } from "./frame-service";

/** Frames sampled across each clip: enough to tell a still shot from a pan and which way it goes, cheap on a phone. */
const SAMPLES = 5;
/** Clips measured per reel; the rest use the engine's fallback (ADR 0059). */
const MAX_CLIPS = 16;
/** How much of a library video is read when it is not in the reel yet: its opening, where a cut into it would land. */
const CANDIDATE_MS = 4000;

/** Five small grey frames across `[startMs, endMs)` of a video, with their times. */
async function sampleFrames(video: HTMLVideoElement, startMs: number, endMs: number): Promise<{ t: number; gray: Gray }[]> {
  const frames: { t: number; gray: Gray }[] = [];
  for (let n = 0; n < SAMPLES; n++) {
    const t = Math.round(startMs + ((endMs - startMs - 80) * n) / (SAMPLES - 1));
    await seekVideo(video, Math.max(0, t));
    frames.push({ t, gray: grayFrame(video) });
  }
  return frames;
}

/**
 * How each video clip moves (ADR 0059, 0067), measured the way the director's
 * evidence is (motion.ts on small grey frames): how much (`energy`, for the
 * pacing engine's hero and holds) and which way at its start and end, with
 * where the moving subject sits (for match cuts and whip directions). Clips
 * already in `known`, and photos (their camera move says it), are skipped. A
 * clip that cannot be read is left out, never guessed.
 */
export async function measureClipMotion(timeline: Timeline, library: Record<string, LibraryAsset>, known: Record<string, ClipMotion>): Promise<Record<string, ClipMotion>> {
  const out: Record<string, ClipMotion> = {};
  const clips = timeline.clips.filter((clip) => clip.kind === "VIDEO" && known[clip.id] === undefined && library[clip.assetId]).slice(0, MAX_CLIPS);
  for (const clip of clips) {
    const asset = library[clip.assetId];
    let video: HTMLVideoElement | null = null;
    try {
      video = await loadVideo(asset.url, asset.fileName);
      const motion = summariseMotion(await sampleFrames(video, clip.sourceStartMs, clip.sourceEndMs));
      if (motion) out[clip.id] = motion;
    } catch {
      // Unreadable here: the engine falls back for this clip.
    } finally {
      if (video) releaseVideo(video);
    }
  }
  return out;
}

/** The energies the pacing engine reads (ADR 0059), from measured motion. */
export function energiesOf(motion: Record<string, ClipMotion>): Record<string, number> {
  return Object.fromEntries(Object.entries(motion).map(([id, m]) => [id, m.energy]));
}

/**
 * The opening motion of library videos not in the reel yet (ADR 0067), for
 * the Add media chips ("after 3": it continues that shot's move). By asset
 * id; null for a video that could not be read, so it is not tried again.
 */
export async function measureAssetMotion(assets: readonly LibraryAsset[], max = 12): Promise<Record<string, ClipMotion | null>> {
  const out: Record<string, ClipMotion | null> = {};
  for (const asset of assets.filter((item) => item.kind === "VIDEO" && !item.isPano).slice(0, max)) {
    let video: HTMLVideoElement | null = null;
    try {
      video = await loadVideo(asset.url, asset.fileName);
      const end = Math.min(asset.durationMs ?? CANDIDATE_MS, CANDIDATE_MS);
      out[asset.id] = end > 400 ? summariseMotion(await sampleFrames(video, 0, end)) : null;
    } catch {
      out[asset.id] = null;
    } finally {
      if (video) releaseVideo(video);
    }
  }
  return out;
}
