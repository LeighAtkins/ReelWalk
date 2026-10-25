/**
 * The moves fixture (ADR 0076), pure so the render package's tests can check it without a renderer: five shots of
 * ffmpeg test pattern with three real moves from the table written onto them by `applyMove`, the same function the
 * Moves sheet and the `applyMove` command call.
 *
 *   c2  crash zoom          a fast eased zoom, landing with a zoom blur on the cut in
 *   c3  parallax slide      a sideways slide across a closer picture
 *   c4  push through        an accelerating push that ends on a zoom-blurred cut into c5
 */
import { applyMove, framePlan, parseTimeline, type MoveId, type Timeline } from "@reelwalk/core";

export const FPS = 30;
export const ASSET_DURATIONS: Record<string, number> = { a: 14_000, b: 14_000, c: 14_000 };

export const MOVE_ROWS: { clipId: string; move: MoveId; label: string }[] = [
  { clipId: "c2", move: "crash-zoom", label: "Crash zoom" },
  { clipId: "c3", move: "parallax-slide", label: "Parallax slide" },
  { clipId: "c4", move: "push-through", label: "Push through" },
];

export function baseTimeline(): Timeline {
  const clip = (id: string, assetId: string, from: number, to: number) => ({ id, assetId, kind: "VIDEO" as const, sourceStartMs: from, sourceEndMs: to, volume: 0, transitionIn: "cut" as const });
  return parseTimeline({
    version: 1,
    clips: [clip("c1", "a", 3000, 5000), clip("c2", "b", 4000, 6000), clip("c3", "c", 4000, 6000), clip("c4", "a", 8000, 10000), clip("c5", "b", 9000, 10500)],
    texts: [],
    music: null,
  });
}

export function movesTimeline(): Timeline {
  return MOVE_ROWS.reduce((timeline, row) => applyMove(timeline, row.clipId, row.move), baseTimeline());
}

/** Ten frames per move: the cut and the fast part for the crash zoom, an even spread for the slide, the run-up and the cut for the push through. */
export function rowFrames(timeline: Timeline, clipId: string): number[] {
  const plan = framePlan(timeline, FPS);
  const index = timeline.clips.findIndex((clip) => clip.id === clipId);
  const entry = plan.clips[index];
  const end = entry.from + entry.durationInFrames - 1;
  if (clipId === "c2") return [-2, 0, 1, 2, 3, 4, 6, 9, 30, entry.durationInFrames - 1].map((offset) => entry.from + offset);
  if (clipId === "c4") return [0, 12, 24, 36, 44, 52].map((offset) => entry.from + offset).concat([end - 1, end, end + 1, end + 3]);
  return Array.from({ length: 10 }, (_, i) => entry.from + Math.round((i * (entry.durationInFrames - 1)) / 9));
}
