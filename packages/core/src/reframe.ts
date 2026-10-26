/**
 * The reframe on the timeline (ADR 0086): a clip's `reframe` from its asset's
 * shot analysis, and the default that turns it on for wide sources in a new cut.
 */
import { cropWidthFor, type ClipReframe } from "./crop-path";
import type { ShotAnalysis } from "./shot-analysis";
import type { Clip, Timeline } from "./timeline";

/** The clip field for an analysed asset: its smoothed crop path, or null when the source is not wider than the reel. */
export function reframeFromAnalysis(analysis: Pick<ShotAnalysis, "width" | "height" | "reframe">): ClipReframe | null {
  const aspect = analysis.width / analysis.height;
  if (cropWidthFor(aspect) >= 1 || !analysis.reframe?.path.length) return null;
  return { aspect: Math.round(aspect * 10000) / 10000, keys: analysis.reframe.path.map((key) => ({ t: key.t, x: key.x })) };
}

/** Whether a clip can take a reframe: flat video, cover-fitted, and no title pinned to its picture (moving it would slide under the pin). */
export function canReframe(timeline: Timeline, clip: Clip): boolean {
  if (clip.kind !== "VIDEO" || clip.fit !== "cover" || clip.pano) return false;
  return !timeline.texts.some((text) => text.pin?.assetId === clip.assetId);
}

/**
 * Turns the reframe on for every wide video clip that does not have one and can take one, from `analyses` by asset id.
 * Clips that already carry a reframe (or that someone set to none) keep it. Use on a NEW cut: a saved reel changes only
 * when someone asks, so existing reels render as they did.
 */
export function applyReframes(timeline: Timeline, analyses: Record<string, Pick<ShotAnalysis, "width" | "height" | "reframe"> | null | undefined>): Timeline {
  let changed = false;
  const clips = timeline.clips.map((clip) => {
    if (clip.reframe || !canReframe(timeline, clip)) return clip;
    const analysis = analyses[clip.assetId];
    const reframe = analysis ? reframeFromAnalysis(analysis) : null;
    if (!reframe) return clip;
    changed = true;
    return { ...clip, reframe };
  });
  return changed ? { ...timeline, clips } : timeline;
}
