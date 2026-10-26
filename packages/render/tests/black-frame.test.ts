import { describe, expect, it } from "vitest";
import { clipStartsMs, framePlan, mediaWindow, msToFrame, windowShortOfSequence } from "@reelwalk/core";
import { blackFrameTimeline, CUTS, FPS, framesToCheck, SOURCE_STARTS } from "../scripts/black-frame-fixture";

/**
 * The black-frame fixture (ADR 0067) stays the regression it is for: cuts off
 * the frame grid, a source window the old trimming came up short on, and
 * every frame the renderer is asked to draw inside a media window.
 */
describe("black-frame fixture", () => {
  const timeline = blackFrameTimeline();
  const plan = framePlan(timeline, FPS);

  it("cuts at the owner's times, each 20–30 ms off a frame boundary", () => {
    expect(clipStartsMs(timeline).slice(1)).toEqual(CUTS);
    for (const cut of CUTS) {
      const frames = (cut * FPS) / 1000;
      const off = Math.abs(frames - Math.round(frames)) * (1000 / FPS);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThanOrEqual(33.4 / 2);
      expect(frames % 1).not.toBe(0);
    }
  });

  it("has the source window the old trimming was one frame short on, and a media window that is not", () => {
    const first = plan.clips[0];
    expect(SOURCE_STARTS[0]).toBe(1020);
    const old = { trimBefore: msToFrame(first.clip.sourceStartMs, FPS), trimAfter: msToFrame(first.clip.sourceEndMs, FPS), playbackRate: 1, gain: 1 };
    expect(windowShortOfSequence(old, first.durationInFrames)).toBe(true);
    for (const entry of plan.clips) {
      for (const frame of [0, Math.floor(entry.durationInFrames / 2), entry.durationInFrames - 1]) {
        expect(windowShortOfSequence(mediaWindow(entry.clip, frame, entry.durationInFrames, FPS), entry.durationInFrames)).toBe(false);
      }
    }
  });

  it("looks at the frames around every cut and every shot's first and last frame, all inside the reel", () => {
    const points = framesToCheck(timeline);
    expect(points.length).toBe(14);
    expect(points.map((p) => p.frame)).toEqual([...points.map((p) => p.frame)].sort((a, b) => a - b));
    for (const [i] of CUTS.entries()) {
      const cut = plan.clips[i].from + plan.clips[i].durationInFrames;
      expect(points.some((p) => p.frame === cut - 1 && p.why.endsWith("last"))).toBe(true);
      expect(points.some((p) => p.frame === cut && p.why.endsWith("first"))).toBe(true);
    }
    expect(Math.max(...points.map((p) => p.frame))).toBeLessThan(plan.totalFrames);
  });

  it("exercises the new motion too: a ramp into the first cut, an eased move, a soft dissolve", () => {
    expect(timeline.clips[0].ramp?.preset).toBe("into-cut");
    expect(timeline.clips[1].camera?.preset).toBe("push-settle");
    expect(timeline.clips[2].transitionIn).toBe("softDissolve");
  });
});
