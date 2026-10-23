import { describe, expect, it } from "vitest";
import { framePlan, hasSpeedRamps, planHasFrozenFrame, speedRampMediaWindow, withSpeedPlans } from "@reelwalk/core";
import { clipPresentation } from "../src/reel/presentation";
import { ASSET_DURATIONS, fixturePlan, FPS, speedRampTimeline, stripFrames } from "../scripts/speed-ramp-fixture";

/**
 * The speed-ramp fixture (ADR 0073): two cuts that take the two main paths of
 * the source-handle rule, and what the composition reads from the plan on the
 * frames around them. The drawn frames are the script's (scripts/speed-ramp.ts).
 */
describe("speed-ramp fixture", () => {
  const timeline = speedRampTimeline();
  const plan = fixturePlan(timeline);
  const planned = withSpeedPlans(timeline, plan);
  const frames = framePlan(planned, FPS);

  it("has two speed-ramp cuts and keeps the reel exactly as long as the same reel with plain cuts", () => {
    expect(hasSpeedRamps(timeline)).toBe(true);
    expect(plan.cuts).toHaveLength(2);
    const plain = framePlan(speedRampTimeline(false), FPS);
    expect(frames.totalFrames).toBe(plain.totalFrames);
    expect(frames.clips.map((entry) => [entry.from, entry.durationInFrames])).toEqual(plain.clips.map((entry) => [entry.from, entry.durationInFrames]));
  });

  it("takes both source paths: source beyond the out-point for the first cut, the slow-down for the second, a lead-in for the second's head", () => {
    const [first, second] = plan.cuts;
    expect(first).toMatchObject({ peak: 5, skipped: false, out: { mode: "handles" }, in: { start: "in-point" } });
    expect(second).toMatchObject({ peak: 3, skipped: false, out: { mode: "compensated" }, in: { start: "preroll" } });
  });

  it("never plays a frame the file does not have, and never repeats one", () => {
    for (const entry of frames.clips) {
      const sourceMs = ASSET_DURATIONS[entry.clip.assetId];
      const speedPlan = (entry.clip as { speedPlan?: Parameters<typeof planHasFrozenFrame>[1] }).speedPlan;
      if (!speedPlan) continue;
      expect(planHasFrozenFrame(entry.clip, speedPlan, FPS)).toBe(false);
      for (let f = 0; f < entry.durationInFrames; f++) {
        const window = speedRampMediaWindow(entry.clip, speedPlan, f, FPS);
        expect(window.sourceFrame).toBeGreaterThanOrEqual(-1e-9);
        expect(window.sourceFrame).toBeLessThanOrEqual((sourceMs * FPS) / 1000 - 1 + 1e-5);
      }
    }
  });

  it("blurs and pushes the frames either side of the cut, strongest on the two nearest it, and nothing else", () => {
    const strip = stripFrames(timeline, 0);
    expect(strip).toHaveLength(20);
    const cut = frames.clips[0].from + frames.clips[0].durationInFrames;
    const shown = (frame: number) => {
      const entry = frames.clips.find((candidate) => frame >= candidate.from && frame < candidate.from + candidate.durationInFrames)!;
      return clipPresentation(entry.clip, frame - entry.from, FPS, entry.durationInFrames, false, null);
    };
    const before = shown(cut - 1), after = shown(cut), far = shown(cut - 12);
    expect(before.speedBlur).not.toBeNull();
    expect(before.speedBlur!.x).toBeGreaterThan(0);
    expect(before.speedBlur!.y).toBe(0);
    expect(before.transform).toMatch(/^scale\(1\.1\)/);
    expect(after.speedBlur!.x).toBeCloseTo(before.speedBlur!.x, 9);
    expect(before.whip).toEqual({ filter: `url(#${before.speedBlur!.id})` });
    expect(far.speedBlur).toBeNull();
    expect(far.whip).toBeUndefined();
    // Ramping eases off: three frames away the blur is a fraction of the peak's.
    expect(shown(cut + 4).speedBlur?.x ?? 0).toBeLessThan(before.speedBlur!.x * 0.4);
  });

  it("leaves every clip of a reel with no speed-ramp cut exactly as it was", () => {
    const plain = speedRampTimeline(false);
    expect(hasSpeedRamps(plain)).toBe(false);
    expect(withSpeedPlans(plain, null)).toBe(plain);
    const entry = framePlan(plain, FPS).clips[0];
    const shown = clipPresentation(entry.clip, entry.durationInFrames - 1, FPS, entry.durationInFrames, false, null);
    expect(shown.speedBlur).toBeNull();
    expect(shown.whip).toBeUndefined();
  });
});
