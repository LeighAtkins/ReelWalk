import { DEFAULT_PANO, MIN_CLIP_MS, clipDurationMs, retimeTexts, type Clip, type Timeline } from "@reelwalk/core";

/** What replacing needs to know about the new media. */
export type ReplacementAsset = { id: string; kind: string; isPano: boolean; durationMs: number | null };

/**
 * A clip shows other media in the same place (ADR 0064, "tap the clip:
 * Replace"). It keeps its id, place, length (as far as the new source
 * allows), look, zoom, fit and transition, so everything around it stays.
 * Titles keep their seconds; a title pinned to the old picture loses its pin
 * (its track was of a surface that is no longer there) and stays where it
 * was on screen.
 */
export function replaceClipSource(timeline: Timeline, clipId: string, asset: ReplacementAsset): Timeline {
  const clip = timeline.clips.find((item) => item.id === clipId);
  if (!clip || asset.kind === "AUDIO" || asset.id === clip.assetId) return timeline;
  const lengthMs = clipDurationMs(clip);
  const isImage = asset.kind === "IMAGE";
  let next: Clip;
  if (isImage) {
    next = { ...clip, assetId: asset.id, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: Math.max(MIN_CLIP_MS, lengthMs), speed: 1, volume: 1 };
  } else {
    const speed = clip.kind === "VIDEO" ? clip.speed : 1;
    const want = Math.max(MIN_CLIP_MS, Math.round(lengthMs * speed));
    const source = asset.durationMs ?? want;
    next = { ...clip, assetId: asset.id, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: Math.max(1, Math.min(want, source)), speed };
  }
  next = {
    ...next,
    pano: asset.isPano ? (clip.pano ?? DEFAULT_PANO) : null,
    motion: asset.isPano ? "none" : clip.motion,
    // Where the old shot was taken says nothing about the new one.
    spot: null,
    room: null,
  };
  const after: Timeline = {
    ...timeline,
    clips: timeline.clips.map((item) => (item.id === clipId ? next : item)),
    texts: timeline.texts.map((text) => (text.pin && text.pin.assetId === clip.assetId && !timeline.clips.some((other) => other.id !== clipId && other.assetId === clip.assetId) ? { ...text, pin: undefined, path: undefined } : text)),
  };
  // Every title keeps its seconds (none is moved with a source window that is no longer there); only the end is enforced.
  return retimeTexts(timeline, after, { except: new Set(timeline.texts.map((text) => text.id)) });
}
