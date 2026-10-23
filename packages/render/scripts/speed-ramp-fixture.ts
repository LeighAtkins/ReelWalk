/**
 * The speed-ramp fixture (ADR 0073), pure so the render package's tests can
 * check it without a renderer: three shots and two speed-ramp cuts that take
 * the two main paths of the source-handle rule. The first cut's outgoing shot
 * has plenty of source after its out-point ("handles") and the incoming shot
 * starts at the very first frame of its file (it begins at the peak, from the
 * in-point); the second cut's outgoing shot ends exactly at the end of its
 * file (the body slows slightly to make up the source, "compensated") and its
 * incoming shot has a lead-in to read ("preroll").
 */
import { framePlan, parseTimeline, planSpeedRamps, SPEED_RAMP_PRESETS, type Timeline } from "@reelwalk/core";

export const FPS = 30;
/** The test files' lengths (ms): the middle shot's file is exactly the 2.5 s the shot uses, so it has nothing before or after it. */
export const ASSET_DURATIONS: Record<string, number> = { a: 14_000, b: 2_500, c: 14_000 };

export function speedRampTimeline(ramps = true): Timeline {
  const clip = (id: string, assetId: string, from: number, to: number, extra: Record<string, unknown> = {}) =>
    ({ id, assetId, kind: "VIDEO" as const, sourceStartMs: from, sourceEndMs: to, volume: 0, transitionIn: "cut" as const, ...extra });
  return parseTimeline({
    version: 1,
    clips: [
      clip("c1", "a", 3000, 5500),
      // The whole of its file: nothing before the in-point (it starts at the peak) and nothing after the out-point (the next cut makes up the source by slowing the body slightly).
      clip("c2", "b", 0, 2500, ramps ? { transitionIn: "speedRamp", speedRamp: { ...SPEED_RAMP_PRESETS.punch, direction: "right" } } : {}),
      // Plenty of lead-in before it: the head reads its pre-roll.
      clip("c3", "c", 9000, 11500, ramps ? { transitionIn: "speedRamp", speedRamp: { ...SPEED_RAMP_PRESETS.soft, direction: "right" } } : {}),
    ],
    texts: [{ id: "t1", text: "SPEED RAMP", startMs: 0, endMs: 7500, x: 0.5, y: 0.5, style: "headline", size: 1.2, animation: "none" }],
    music: null,
  });
}

/** The plan the composition makes for the fixture (its reports say which path each cut took). */
export function fixturePlan(timeline = speedRampTimeline()) {
  return planSpeedRamps(framePlan(timeline, FPS).clips.map(({ clip, durationInFrames }) => ({ clip, durationInFrames, sourceDurationMs: ASSET_DURATIONS[clip.assetId] })), FPS);
}

/** Every frame across the first cut: from `before` frames ahead of it to `after` frames past it. */
export function stripFrames(timeline: Timeline, cutIndex: number, before = 10, after = 10): number[] {
  const plan = framePlan(timeline, FPS);
  const cut = plan.clips[cutIndex].from + plan.clips[cutIndex].durationInFrames;
  return Array.from({ length: before + after }, (_, i) => cut - before + i);
}
