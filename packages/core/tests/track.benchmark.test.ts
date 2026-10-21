import { describe, expect, it } from "vitest";
import { benchmark, table, totals } from "./track-bench/bench";
import { scenarios } from "./track-bench/synth";

// The full ADR 0052 benchmark at the editor's tracking size (360 × 640, 30 frames) is slow because the
// legacy tracker brute-forces every patch: TRACK_BENCH=1 pnpm --filter @reelwalk/core exec vitest run tests/track.benchmark.test.ts
describe.runIf(process.env.TRACK_BENCH)("surface tracking benchmark (full)", () => {
  it("meets the claims in ADR 0052", () => {
    const rows = benchmark(scenarios(360, 640, 30));
    console.log(`\n${table(rows)}\n`);
    const legacy = totals(rows, "legacy"), fresh = totals(rows, "new");
    expect(rows.find((r) => r.scenario === "blank wall" && r.tracker === "new")!.shown).toBe(0);
    expect(fresh.falseConfident).toBe(0);
    expect(fresh.shownWrong).toBe(0);
    expect(fresh.falseConfident).toBeLessThan(legacy.falseConfident);
    expect(fresh.meanErr!).toBeLessThan(0.6);
    expect(fresh.meanErr!).toBeLessThan(legacy.meanErr!);
    // Frame-to-frame shimmer of the saved corners, px at 360 wide (× 3 for 1080): smoothing must actually smooth.
    const jitter = (name: string) => rows.find((r) => r.scenario === name && r.tracker === "new")!.jitter!;
    expect(jitter("pan (parallax)")).toBeLessThan(0.1);
    expect(jitter("push-in")).toBeLessThan(0.1);
    expect(jitter("orbit (perspective)")).toBeLessThan(0.3);
  }, 600_000);
});

describe("surface tracking benchmark (small)", () => {
  const rows = benchmark(scenarios(144, 256, 16));
  const wrongPx = 3 * (144 / 360);

  it("never draws a blank wall", () => {
    const blank = rows.find((r) => r.scenario === "blank wall" && r.tracker === "new")!;
    expect(blank.shown).toBe(0);
  });

  it("is no more falsely confident than the legacy tracker, and rarely at all", () => {
    const legacy = totals(rows, "legacy"), fresh = totals(rows, "new");
    expect(fresh.falseConfident).toBeLessThanOrEqual(legacy.falseConfident);
    expect(fresh.falseConfident / fresh.frames).toBeLessThan(0.05);
    expect(fresh.shownWrong / fresh.frames).toBeLessThan(0.05);
  });

  it("follows textured surfaces within a few pixels", () => {
    for (const name of ["pan (parallax)", "push-in", "handheld"]) {
      const r = rows.find((x) => x.scenario === name && x.tracker === "new")!;
      expect(r.meanErr, name).not.toBeNull();
      expect(r.meanErr!, name).toBeLessThan(wrongPx);
    }
  });
});
