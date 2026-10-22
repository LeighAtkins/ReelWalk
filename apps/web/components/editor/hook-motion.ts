import { motionProfile, type Gray, type MotionSample, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { grayFrame } from "./frame-analysis";
import { loadImage, loadVideo, luminance, releaseVideo, seekVideo } from "./frame-service";

/** Frames read across each clip's opening: the step is about a tenth of a second, enough to find where a move is strongest. */
const SAMPLES = 7;
/** How far into each clip's window the opening is measured, ms of source. */
const OPENING_MS = 3000;
/** Clips measured per reel; the rest use the planner's fallbacks. */
const MAX_CLIPS = 12;

export type OpeningMeasure = {
  /** Motion samples by clip id over the clip's opening (motion.ts, ADR 0034). */
  motion: Record<string, MotionSample[]>;
  /** Mean luma (0–1) of each clip's first frame, by clip id. */
  clipLuma: Record<string, number>;
};

export const emptyMeasure = (): OpeningMeasure => ({ motion: {}, clipLuma: {} });

const meanLuma = (gray: Gray) => {
  let sum = 0;
  for (const v of gray.data) sum += v;
  return gray.data.length ? sum / gray.data.length / 255 : 0;
};

/**
 * Measures how each clip's opening moves and how bright it is (ADR 0068), the
 * way the pacing engine's clip energy is measured (`clip-energy.ts`): small
 * grey frames read through the clip's source window. Clips already in
 * `known` are skipped; a clip that cannot be read is left out, never guessed.
 * `live()` false stops the run between clips.
 */
export async function measureOpenings(timeline: Timeline, library: Record<string, LibraryAsset>, known: OpeningMeasure, live: () => boolean = () => true): Promise<OpeningMeasure> {
  const out = emptyMeasure();
  const clips = timeline.clips.filter((clip) => library[clip.assetId] && (known.motion[clip.id] === undefined || known.clipLuma[clip.id] === undefined)).slice(0, MAX_CLIPS);
  for (const clip of clips) {
    if (!live()) break;
    const asset = library[clip.assetId];
    if (clip.kind === "IMAGE") {
      if (asset.isPano) continue;
      try {
        const image = await loadImage(asset.url);
        const canvas = document.createElement("canvas");
        canvas.width = 48; canvas.height = 85;
        canvas.getContext("2d")?.drawImage(image, 0, 0, 48, 85);
        out.clipLuma[clip.id] = meanLuma(luminance(canvas));
      } catch {
        // Unreadable here (no CORS, a missing file): the planner goes by the clip's fields.
      }
      continue;
    }
    let video: HTMLVideoElement | null = null;
    try {
      video = await loadVideo(asset.url, asset.fileName);
      const span = Math.min(OPENING_MS * clip.speed, clip.sourceEndMs - clip.sourceStartMs - 80);
      const frames: { t: number; gray: Gray }[] = [];
      for (let n = 0; n < SAMPLES; n++) {
        if (!live()) break;
        const t = Math.round(clip.sourceStartMs + (span * n) / (SAMPLES - 1));
        await seekVideo(video, Math.max(0, t));
        frames.push({ t, gray: grayFrame(video) });
      }
      if (frames.length < 2) continue;
      out.motion[clip.id] = motionProfile(frames);
      out.clipLuma[clip.id] = meanLuma(frames[0].gray);
    } catch {
      // Left out; the planner falls back for this clip.
    } finally {
      if (video) releaseVideo(video);
    }
  }
  return { motion: { ...known.motion, ...out.motion }, clipLuma: { ...known.clipLuma, ...out.clipLuma } };
}
