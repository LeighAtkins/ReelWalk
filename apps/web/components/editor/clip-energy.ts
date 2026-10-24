import { edgeSampleTimes, readMotion, summariseMotion, withReads, type Clip, type ClipMotion, type Gray, type MotionRead, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { grayFrame } from "./frame-analysis";
import { loadVideo, releaseVideo, seekVideo } from "./frame-service";

/** Frames sampled across each clip: enough to tell a still shot from a pan and which way it goes, cheap on a phone. */
const SAMPLES = 5;
/** The size of the frames the camera reading takes: twice the spread frames', so a drift of a few hundredths of a frame width a second still moves a pixel (ADR 0074). */
const EDGE_WIDTH = 96;
const EDGE_HEIGHT = 170;
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

/** What the camera does over a clip's first or last half second (ADR 0074): three small frames across it, read as one flow. */
async function readEdge(video: HTMLVideoElement, clip: Clip, side: "head" | "tail"): Promise<MotionRead | null> {
  const frames: { t: number; gray: Gray }[] = [];
  for (const t of edgeSampleTimes(side, clip.sourceStartMs, clip.sourceEndMs, clip.speed || 1)) {
    await seekVideo(video, t);
    frames.push({ t, gray: grayFrame(video, EDGE_WIDTH, EDGE_HEIGHT) });
  }
  return readMotion(frames);
}

/**
 * How each video clip moves (ADR 0059, 0067), measured the way the director's
 * evidence is (motion.ts on small grey frames): how much (`energy`, for the
 * pacing engine's hero and holds) and which way at its start and end, with
 * where the moving subject sits (for match cuts and whip directions). Clips
 * already in `known`, and photos (their camera move says it), are skipped. A
 * clip that cannot be read is left out, never guessed.
 */
export async function measureClipMotion(timeline: Timeline, library: Record<string, LibraryAsset>, known: Record<string, ClipMotion>, { edges = false }: { edges?: boolean } = {}): Promise<Record<string, ClipMotion>> {
  const out: Record<string, ClipMotion> = {};
  // `edges`: also read what the camera does at each end of the clip (ADR 0074); a clip measured before without them is read again.
  const wanted = (clip: Clip) => known[clip.id] === undefined || (edges && (known[clip.id].startRead === undefined || known[clip.id].endRead === undefined));
  const clips = timeline.clips.filter((clip) => clip.kind === "VIDEO" && wanted(clip) && library[clip.assetId]).slice(0, MAX_CLIPS);
  for (const clip of clips) {
    const asset = library[clip.assetId];
    let video: HTMLVideoElement | null = null;
    try {
      video = await loadVideo(asset.url, asset.fileName);
      const motion = known[clip.id] ?? summariseMotion(await sampleFrames(video, clip.sourceStartMs, clip.sourceEndMs));
      if (motion) out[clip.id] = edges ? withReads(motion, await readEdge(video, clip, "head"), await readEdge(video, clip, "tail")) : motion;
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
