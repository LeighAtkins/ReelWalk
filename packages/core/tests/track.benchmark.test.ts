import { describe, expect, it } from "vitest";
import { benchmark, table } from "./track-bench/bench";
import { scenarios } from "./track-bench/synth";

// The full ADR 0052 benchmark at the editor's tracking size (360 × 640, 30 frames) is slow because the
// legacy tracker brute-forces every patch: run it with TRACK_BENCH=1 pnpm --filter @reelwalk/core test track.benchmark
describe.runIf(process.env.TRACK_BENCH)("surface tracking benchmark (full)", () => {
  it("prints before/after numbers", () => {
    const rows = benchmark(scenarios(360, 640, 30));
    console.log(`\n${table(rows)}\n`);
  }, 600_000);
});

describe("surface tracking benchmark (small)", () => {
  const rows = benchmark(scenarios(144, 256, 16));
  const wrongPx = 3 * (144 / 360);

  it("never claims confidence on a blank wall", () => {
    const blank = rows.find((r) => r.scenario === "blank wall" && r.tracker === "new")!;
    expect(blank.confident).toBe(0);
  });

  it("is no more falsely confident than the legacy tracker, and rarely at all", () => {
    const total = (tracker: string) => rows.filter((r) => r.tracker === tracker).reduce((s, r) => s + r.falseConfident, 0);
    const frames = rows.filter((r) => r.tracker === "new").reduce((s, r) => s + r.frames, 0);
    expect(total("new")).toBeLessThanOrEqual(total("legacy"));
    expect(total("new") / frames).toBeLessThan(0.05);
  });

  it("follows textured surfaces within a few pixels", () => {
    for (const name of ["pan (parallax)", "push-in", "handheld"]) {
      const r = rows.find((x) => x.scenario === name && x.tracker === "new")!;
      expect(r.meanErr, name).not.toBeNull();
      expect(r.meanErr!, name).toBeLessThan(wrongPx);
    }
  });
});
