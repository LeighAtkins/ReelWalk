import { describe, expect, it } from "vitest";
import { clipEdgeWindow, MIN_TEXT_DRAG_MS, retimeText, snapTime, type Clip } from "../src";

const options = { totalMs: 10_000, snapPoints: [0, 4_000, 10_000], snapMs: 150 };
const text = { startMs: 1_000, endMs: 5_000 };

describe("snapTime", () => {
  it("rounds to a tenth of a second away from snap points", () => {
    expect(snapTime(2_345, [4_000], 150)).toEqual({ ms: 2_300, hit: false });
  });
  it("sticks to the nearest snap point in reach", () => {
    expect(snapTime(3_900, [4_000, 3_850], 150)).toEqual({ ms: 3_850, hit: true });
  });
});

describe("retimeText", () => {
  it("shortens from the end: 4 s down to 2.5 s", () => {
    expect(retimeText(text, "end", -1_500, options)).toEqual({ startMs: 1_000, endMs: 3_500 });
  });
  it("snaps the end to a cut", () => {
    expect(retimeText(text, "end", -1_080, options)).toEqual({ startMs: 1_000, endMs: 4_000 });
  });
  it("keeps a minimum time on screen", () => {
    expect(retimeText(text, "end", -9_000, options)).toEqual({ startMs: 1_000, endMs: 1_000 + MIN_TEXT_DRAG_MS });
    expect(retimeText(text, "start", 9_000, options)).toEqual({ startMs: 5_000 - MIN_TEXT_DRAG_MS, endMs: 5_000 });
  });
  it("stays inside the reel", () => {
    expect(retimeText(text, "start", -5_000, options)).toEqual({ startMs: 0, endMs: 5_000 });
    expect(retimeText(text, "end", 50_000, options)).toEqual({ startMs: 1_000, endMs: 10_000 });
  });
  it("moves without changing length", () => {
    expect(retimeText(text, "move", 1_230, options)).toEqual({ startMs: 2_200, endMs: 6_200 });
    expect(retimeText(text, "move", 20_000, options)).toEqual({ startMs: 6_000, endMs: 10_000 });
    expect(retimeText(text, "move", -20_000, options)).toEqual({ startMs: 0, endMs: 4_000 });
  });
  it("moves so the end lands on a cut", () => {
    // End would be at 9 950, near the 10 000 snap point; start has none nearby.
    expect(retimeText(text, "move", 4_950, options)).toEqual({ startMs: 6_000, endMs: 10_000 });
  });
});

describe("clipEdgeWindow", () => {
  const video = { kind: "VIDEO", sourceStartMs: 1_000, sourceEndMs: 5_000, speed: 2 } as Clip;
  const photo = { kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3_000, speed: 1 } as Clip;
  it("maps timeline time to source time through the speed", () => {
    expect(clipEdgeWindow(video, "end", 500)).toEqual({ sourceStartMs: 1_000, sourceEndMs: 6_000 });
    expect(clipEdgeWindow(video, "start", 250)).toEqual({ sourceStartMs: 1_500, sourceEndMs: 5_000 });
  });
  it("changes a photo's length from either edge", () => {
    expect(clipEdgeWindow(photo, "end", 1_000)).toEqual({ sourceStartMs: 0, sourceEndMs: 4_000 });
    expect(clipEdgeWindow(photo, "start", 1_000)).toEqual({ sourceStartMs: 0, sourceEndMs: 2_000 });
  });
});
