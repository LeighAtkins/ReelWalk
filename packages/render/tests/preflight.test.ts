import { describe, expect, it } from "vitest";
import { parseTimeline } from "@reelwalk/core";
import { reelCheckpoints } from "../src/render-reel";

describe("render preflight", () => {
  it("checks the first and last frame of every shot", () => {
    const timeline = parseTimeline({ version: 1, music: null, clips: [
      { id: "a", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1000 },
      { id: "b", assetId: "y", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 500 },
      { id: "c", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000, speed: 2 },
    ], texts: [] });
    expect(reelCheckpoints(timeline, 30)).toEqual([
      { frame: 0, shot: 1, edge: "first", clipId: "a" }, { frame: 29, shot: 1, edge: "last", clipId: "a" },
      { frame: 30, shot: 2, edge: "first", clipId: "b" }, { frame: 44, shot: 2, edge: "last", clipId: "b" },
      { frame: 45, shot: 3, edge: "first", clipId: "c" }, { frame: 74, shot: 3, edge: "last", clipId: "c" },
    ]);
  });
});
