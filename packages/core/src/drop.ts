import { PANO_MIN_MS } from "./pacing";
import { clipDurationMs, clipStartsMs, isInstagramMusic, MIN_CLIP_MS, type Clip, type Timeline } from "./timeline";

/**
 * "Put the drop on cut N" (ADR 0066). Your own song can start anywhere, so
 * the track is moved: the reel starts `dropMs − cutMs` into it. An Instagram
 * sound always plays from its start (ADR 0019), so the cut is moved instead:
 * the shots before it are stretched or squeezed, each within its source and
 * never under the shortest clip, so that cut N lands on the drop. Titles
 * follow their clips through the command layer's retime.
 */

/** Cuts are numbered from 1: cut N is the start of clip N (clip 0 starts the reel). */
export function placeDropOnCut(timeline: Timeline, cutIndex: number, dropSongMs: number, sourceDurationsMs: Record<string, number | null | undefined> = {}): Timeline {
  const music = timeline.music;
  if (!music || cutIndex < 1 || cutIndex >= timeline.clips.length) return timeline;
  const starts = clipStartsMs(timeline);
  const cutMs = starts[cutIndex];
  const record = { drop: { songMs: Math.round(dropSongMs), cutIndex } };
  if (!isInstagramMusic(music)) {
    const sourceStartMs = Math.round(dropSongMs - cutMs);
    if (sourceStartMs >= 0) return { ...timeline, music: { ...music, sourceStartMs, ...record } };
    // The drop comes too early in the song for this cut: the track stays at its start and the cut moves instead.
  }
  const clips = fitCutTo(timeline.clips, cutIndex, Math.round(dropSongMs - music.sourceStartMs), sourceDurationsMs);
  if (!clips) return timeline;
  return { ...timeline, clips, music: { ...music, ...record } };
}

/**
 * The clips before `cutIndex` scaled so that cut lands at `targetMs`: each
 * by the same factor, then clamped to its own limits, with the remainder
 * taken up by the last clips that still have room. Null when the shots
 * cannot be made to fit.
 */
export function fitCutTo(clips: readonly Clip[], cutIndex: number, targetMs: number, sourceDurationsMs: Record<string, number | null | undefined>): Clip[] | null {
  const before = clips.slice(0, cutIndex);
  const current = before.reduce((sum, clip) => sum + clipDurationMs(clip), 0);
  if (current === 0 || targetMs < MIN_CLIP_MS * before.length) return null;
  const limits = before.map((clip) => {
    const min = Math.max(MIN_CLIP_MS, clip.pano ? PANO_MIN_MS : 0);
    if (clip.kind === "IMAGE") return { min, max: Infinity };
    const source = sourceDurationsMs[clip.assetId] ?? clip.sourceEndMs;
    return { min, max: Math.floor(source / clip.speed) };
  });
  const factor = targetMs / current;
  const lengths = before.map((clip, i) => Math.min(limits[i].max, Math.max(limits[i].min, Math.round(clipDurationMs(clip) * factor))));
  // Spread what the clamps left over (or took too much of) across the clips that still have room, from the cut backwards.
  let remainder = targetMs - lengths.reduce((sum, ms) => sum + ms, 0);
  for (let i = before.length - 1; i >= 0 && remainder !== 0; i--) {
    const room = remainder > 0 ? limits[i].max - lengths[i] : limits[i].min - lengths[i];
    const take = remainder > 0 ? Math.min(remainder, room) : Math.max(remainder, room);
    lengths[i] += take;
    remainder -= take;
  }
  if (remainder !== 0) return null;
  if (lengths.every((ms, i) => ms === clipDurationMs(before[i]))) return [...clips];
  const fitted = before.map((clip, i) => {
    const ms = lengths[i];
    if (clip.kind === "IMAGE") return { ...clip, sourceEndMs: clip.sourceStartMs + ms };
    const sourceLength = Math.round(ms * clip.speed);
    const source = sourceDurationsMs[clip.assetId] ?? clip.sourceEndMs;
    // Grow at the end; slide the window earlier only when the source runs out.
    const start = Math.max(0, Math.min(clip.sourceStartMs, source - sourceLength));
    return { ...clip, sourceStartMs: start, sourceEndMs: start + sourceLength };
  });
  return [...fitted, ...clips.slice(cutIndex)];
}
