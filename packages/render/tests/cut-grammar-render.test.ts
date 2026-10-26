import { describe, expect, it } from "vitest";
import { planCuts, soundBridges, transitionFrames } from "../src/reel/transition-plan";
import { depthBlurAt, depthBytes, depthMask, wipeEdgeAt, wipeMask, zoomThroughStyle, ZOOM_IN_FROM } from "../src/reel/toolbox/grammar-presentations";

/** The cut grammar's drawn techniques (ADR 0087): pure parts of the presentations and the plan. */
describe("cut grammar transitions", () => {
  const wipe = { from: "left" as const, edge: [0, 0.2, 0.5, 0.7, 1], soft: 0.06 };

  it("keeps the 12-frame cap", () => {
    expect(transitionFrames("occlusionWipe", 30)).toBe(12);
    expect(transitionFrames("zoomThrough", 30)).toBe(12);
  });

  it("carries the planner's parameters on the cut plan", () => {
    const cuts = planCuts([
      { clip: { transitionIn: "cut" as const }, durationInFrames: 60 },
      { clip: { transitionIn: "occlusionWipe" as const, cut: { technique: "occlusionWipe" as const, reason: "test reason", wipe } }, durationInFrames: 60 },
    ], 30);
    expect(cuts[1]).toEqual({ kind: "occlusionWipe", frames: 12, before: 6, after: 6, params: { wipe } });
  });

  it("starts the wipe off the frame, follows the edge, and finishes across it", () => {
    expect(wipeEdgeAt(wipe, 0)).toBeCloseTo(-0.06);
    expect(wipeEdgeAt(wipe, 1)).toBeCloseTo(1.06);
    const mid = wipeEdgeAt(wipe, 0.5);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    for (let p = 0.05; p <= 1; p += 0.05) expect(wipeEdgeAt(wipe, p)).toBeGreaterThanOrEqual(wipeEdgeAt(wipe, p - 0.05) - 1e-9);
    expect(wipeMask({ ...wipe, from: "top" }, 0.5)).toMatch(/^linear-gradient\(to bottom, black/);
  });

  it("pushes the outgoing shot into its region and settles the incoming one out of its own", () => {
    const zoom = { ax: 0.3, ay: 0.4, bx: 0.6, by: 0.5, scale: 2.4 };
    expect(zoomThroughStyle(zoom, "exiting", 0)).toMatchObject({ scale: 1, opacity: 1, blur: 0, origin: "30.0% 40.0%" });
    expect(zoomThroughStyle(zoom, "exiting", 1)).toMatchObject({ scale: 2.4, opacity: 0 });
    expect(zoomThroughStyle(zoom, "entering", 0)).toMatchObject({ scale: ZOOM_IN_FROM, opacity: 0, origin: "60.0% 50.0%" });
    expect(zoomThroughStyle(zoom, "entering", 1)).toMatchObject({ scale: 1, opacity: 1, blur: 0 });
  });

  it("reads a depth grid and blurs the far side first on the way out", () => {
    const grid = { cols: 2, rows: 2, grid: btoa(String.fromCharCode(0, 255, 128, 64)) };
    expect([...depthBytes(grid)!]).toEqual([0, 255, 128, 64]);
    expect(depthBytes({ ...grid, cols: 3 })).toBeNull();
    expect(depthMask(grid, "far")).toMatch(/^url\("data:image\/svg\+xml/);
    expect(depthBlurAt("exiting", 0)).toBe(0);
    expect(depthBlurAt("exiting", 0.4)).toBeGreaterThan(10);
    expect(depthBlurAt("entering", 1)).toBe(0);
  });
});

describe("soundBridges", () => {
  const clip = (id: string, assetId: string, start: number, end: number, cut?: { jMs?: number; lMs?: number }) => ({
    id, assetId, kind: "VIDEO" as const, volume: 0.25, speed: 1, sourceStartMs: start, sourceEndMs: end,
    ...(cut ? { cut: { technique: "eyeTrace" as const, reason: "test reason", ...cut } } : {}),
  });

  it("leads with the next room's sound on a J-cut and lets the last one linger on an L-cut", () => {
    const bridges = soundBridges([
      { clip: clip("a", "A", 1000, 3000), from: 0, durationInFrames: 60 },
      { clip: clip("b", "B", 2000, 4000, { jMs: 300 }), from: 60, durationInFrames: 60 },
      { clip: clip("c", "C", 500, 2500, { lMs: 300 }), from: 120, durationInFrames: 60 },
    ], 30, { B: 10_000 });
    expect(bridges).toEqual([
      { key: "j-b", assetId: "B", from: 51, durationInFrames: 9, sourceStartMs: 1700, volume: 0.25, fade: "in" },
      { key: "l-c", assetId: "B", from: 120, durationInFrames: 9, sourceStartMs: 4000, volume: 0.25, fade: "out" },
    ]);
  });

  it("never reads before the source starts or bridges a clip to itself", () => {
    expect(soundBridges([
      { clip: clip("a", "A", 0, 3000), from: 0, durationInFrames: 60 },
      { clip: clip("b", "B", 0, 2000, { jMs: 300 }), from: 60, durationInFrames: 60 },
      { clip: clip("c", "B", 2000, 3000, { lMs: 300 }), from: 120, durationInFrames: 30 },
    ], 30)).toEqual([]);
  });
});
