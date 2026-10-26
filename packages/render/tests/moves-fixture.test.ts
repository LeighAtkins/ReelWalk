import { describe, expect, it } from "vitest";
import { cameraKeysAt, framePlan, moveById } from "@reelwalk/core";
import { FPS, MOVE_ROWS, baseTimeline, movesTimeline, rowFrames } from "../scripts/moves-fixture";

/** The moves fixture (ADR 0076): three real moves from the table written by `applyMove`, ten frames of each to draw. */
describe("moves fixture", () => {
  const timeline = movesTimeline();
  const plan = framePlan(timeline, FPS);
  const clip = (id: string) => timeline.clips.find((item) => item.id === id)!;

  it("writes the three moves onto their shots and nothing onto the others", () => {
    expect(clip("c2").camera?.keys[1].scale).toBeGreaterThan(1.6);
    // The speed-ramp cut the crash zoom also wrote was retired (ADR 0082): the cut stays a cut.
    expect(clip("c2").transitionIn).toBe("cut");
    expect(cameraKeysAt(clip("c3").camera!, 0).x).toBeLessThan(0);
    expect(cameraKeysAt(clip("c3").camera!, 1).x).toBeGreaterThan(0);
    expect(cameraKeysAt(clip("c4").camera!, 1).scale).toBeGreaterThan(1.9);
    expect(clip("c5").transitionIn).toBe("cut");
    expect(clip("c1").camera ?? null).toBeNull();
    expect(clip("c1").transitionIn).toBe("cut");
    // The moves change how the shots look, never how long they are.
    expect(timeline.clips.map((c) => c.sourceEndMs - c.sourceStartMs)).toEqual(baseTimeline().clips.map((c) => c.sourceEndMs - c.sourceStartMs));
  });

  it("asks for ten distinct frames per move, each inside the reel, the crash zoom's from just before its cut", () => {
    const total = plan.clips.reduce((sum, entry) => sum + entry.durationInFrames, 0);
    for (const row of MOVE_ROWS) {
      const frames = rowFrames(timeline, row.clipId);
      expect(frames).toHaveLength(10);
      expect(new Set(frames).size).toBe(10);
      for (const frame of frames) { expect(frame).toBeGreaterThanOrEqual(0); expect(frame).toBeLessThan(total); }
      expect(moveById(row.move).real).not.toBeNull();
    }
    const crash = plan.clips[1];
    expect(rowFrames(timeline, "c2")[0]).toBe(crash.from - 2);
  });
});
