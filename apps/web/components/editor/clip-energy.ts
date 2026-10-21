import { clipEnergyFromMotion, motionProfile, type Gray, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { grayFrame } from "./frame-analysis";
import { loadVideo, releaseVideo, seekVideo } from "./frame-service";

/** Frames sampled across each clip: enough to tell a still shot from a pan, cheap on a phone. */
const SAMPLES = 5;
/** Clips measured per reel; the rest use the engine's fallback (ADR 0059). */
const MAX_CLIPS = 16;

/**
 * How much each video clip moves (ADR 0059), measured the way the director's
 * evidence is (motion.ts on small grey frames), for the pacing engine to pick
 * the hero and give lively shots shorter holds. Clips already in `known`, and
 * photos (their camera move says it), are skipped. A clip that cannot be read
 * is left out, never guessed.
 */
export async function measureClipEnergies(timeline: Timeline, library: Record<string, LibraryAsset>, known: Record<string, number>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const clips = timeline.clips.filter((clip) => clip.kind === "VIDEO" && known[clip.id] === undefined && library[clip.assetId]).slice(0, MAX_CLIPS);
  for (const clip of clips) {
    const asset = library[clip.assetId];
    let video: HTMLVideoElement | null = null;
    try {
      video = await loadVideo(asset.url, asset.fileName);
      const frames: { t: number; gray: Gray }[] = [];
      for (let n = 0; n < SAMPLES; n++) {
        const t = Math.round(clip.sourceStartMs + ((clip.sourceEndMs - clip.sourceStartMs - 80) * n) / (SAMPLES - 1));
        await seekVideo(video, Math.max(0, t));
        frames.push({ t, gray: grayFrame(video) });
      }
      const energy = clipEnergyFromMotion(motionProfile(frames));
      if (energy !== null) out[clip.id] = energy;
    } catch {
      // Unreadable here: the engine falls back for this clip.
    } finally {
      if (video) releaseVideo(video);
    }
  }
  return out;
}
