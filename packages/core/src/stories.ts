/**
 * Instagram Stories (ADR 0065). A story that goes out with a reel is a
 * *story cut*: the reel's opening (its hook, 8–12 s) and a two-second
 * closing plate in the house serif reading "new reel · @handle". It is
 * rendered by the same Remotion composition as the reel, from a timeline
 * derived here; nothing is copied and the source reel is not changed.
 *
 * Pure and deterministic: the same reel gives the same cut.
 */
import { MIN_CLIP_MS, clipDurationMs, clipStartsMs, timelineDurationMs, timelineSchema, type Clip, type Timeline } from "./timeline";

/** The story cut keeps at least this much of the reel's opening, when the reel has it. */
export const STORY_HOOK_MIN_MS = 8000;
/** And at most this much: a story is watched with a thumb hovering over "next". */
export const STORY_HOOK_MAX_MS = 12_000;
/** Where the opening is cut when no shot ends between the bounds. */
export const STORY_HOOK_TARGET_MS = 10_000;
/** The closing plate. */
export const STORY_END_CARD_MS = 2000;
/** The plate clip's id in a story cut. */
export const STORY_END_CARD_CLIP_ID = "story-end-card";
/** Instagram's limits for a video story (Graph API media reference, read 2026-10-22). */
export const STORY_LIMITS = { minDurationMs: 3000, maxDurationMs: 60_000, maxBytes: 100 * 1024 * 1024 } as const;
/** A title shorter than this after the cut is dropped rather than flashed. */
const MIN_TEXT_MS = 300;

/** The plate's words. The handle is the connected account's username, without the @. */
export function storyEndCardText(handle: string): string {
  const clean = handle.trim().replace(/^@+/, "");
  return clean ? `new reel · @${clean}` : "new reel";
}

/**
 * Where the opening is cut, in reel time. The whole reel when it is no
 * longer than the upper bound; else the last cut between the bounds, so the
 * story ends on an edit the studio made; else straight at the target.
 */
export function storyHookMs(timeline: Timeline): number {
  const total = timelineDurationMs(timeline);
  if (total <= STORY_HOOK_MAX_MS) return total;
  const ends = clipStartsMs(timeline).slice(1).filter((ms) => ms >= STORY_HOOK_MIN_MS && ms <= STORY_HOOK_MAX_MS);
  return ends.length > 0 ? ends[ends.length - 1] : STORY_HOOK_TARGET_MS;
}

/** Whether a finished reel may be posted as a story as it is. */
export function fullReelStoryProblem(durationMs: number, sizeBytes?: number | null): string | null {
  if (durationMs > STORY_LIMITS.maxDurationMs) return `Stories run up to ${STORY_LIMITS.maxDurationMs / 1000} s; this reel is ${Math.round(durationMs / 1000)} s. Post the story cut instead.`;
  if (durationMs < STORY_LIMITS.minDurationMs) return "A story must be at least 3 s.";
  if (sizeBytes && sizeBytes > STORY_LIMITS.maxBytes) return "Stories can be 100 MB at most.";
  return null;
}

/** The last kept shot again, silent, under the plate: the composition needs footage for every frame. */
function plateClip(last: Clip): Clip {
  const speed = last.kind === "IMAGE" ? 1 : last.speed;
  const want = Math.round(STORY_END_CARD_MS * speed);
  const window = last.sourceEndMs - last.sourceStartMs;
  // Only footage the shot already plays: never past the end of a source.
  const sourceStartMs = last.kind === "IMAGE" ? 0 : window >= want ? last.sourceEndMs - want : last.sourceStartMs;
  const sourceEndMs = last.kind === "IMAGE" ? STORY_END_CARD_MS : Math.min(last.sourceEndMs, sourceStartMs + want);
  return { ...last, id: STORY_END_CARD_CLIP_ID, sourceStartMs, sourceEndMs, volume: 0, transitionIn: "fade", motion: "none", zoom: 1 };
}

export type StoryCut = { timeline: Timeline; hookMs: number; totalMs: number };

/**
 * The story cut of a reel: its opening up to `storyHookMs`, titles clipped to
 * it, then the plate. A shot left shorter than the editor's minimum by the
 * cut is dropped and the opening ends on the shot before. A facts card
 * placed at the end is left out (the plate is the ending); one at the start
 * stays. Throws for a reel with no shots.
 */
export function planStoryCut(source: Timeline, input: { handle: string }): StoryCut {
  if (source.clips.length === 0) throw new Error("The reel has no shots.");
  let hookMs = storyHookMs(source);
  const starts = clipStartsMs(source);
  const clips: Clip[] = [];
  for (const [index, clip] of source.clips.entries()) {
    const start = starts[index];
    if (start >= hookMs) break;
    const keepMs = Math.min(clipDurationMs(clip), hookMs - start);
    if (keepMs < MIN_CLIP_MS && clips.length > 0) {
      hookMs = start;
      break;
    }
    if (keepMs < clipDurationMs(clip)) {
      const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
      clips.push({ ...clip, sourceEndMs: clip.sourceStartMs + Math.round(keepMs * speed) });
    } else {
      clips.push(clip);
    }
  }
  hookMs = clips.reduce((total, clip) => total + clipDurationMs(clip), 0);

  const texts = source.texts
    .filter((text) => text.startMs < hookMs)
    .map((text) => (text.endMs > hookMs ? { ...text, endMs: hookMs } : text))
    .filter((text) => text.endMs - text.startMs >= MIN_TEXT_MS);

  const details = source.details
    ? source.details.placement === "end"
      ? { ...source.details, placement: "none" as const }
      : source.details.placement === "both"
        ? { ...source.details, placement: "start" as const }
        : source.details
    : null;
  const cover = source.cover && clips.some((clip) => clip.id === source.cover!.clipId) ? source.cover : null;

  const plate = plateClip(clips[clips.length - 1]);
  const timeline = timelineSchema.parse({
    ...source,
    clips: [...clips, plate],
    texts,
    details,
    cover,
    endCard: { text: storyEndCardText(input.handle), durationMs: clipDurationMs(plate) },
  });
  return { timeline, hookMs, totalMs: timelineDurationMs(timeline) };
}
