import { describe, expect, it } from "vitest";
import { addClips, canExport, countHashtags, emptyTimeline, instagramIssues, isInSafeArea, type Clip, type Timeline } from "../src";

function photo(id: string, durationMs: number): Clip {
  return {
    id,
    assetId: id,
    kind: "IMAGE",
    sourceStartMs: 0,
    sourceEndMs: durationMs,
    speed: 1,
    volume: 1,
    fit: "cover",
    filter: "none",
    motion: "none",
    transitionIn: "cut",
  };
}

const codes = (timeline: Timeline, caption?: string) => instagramIssues(timeline, caption).map((issue) => issue.code);

describe("instagramIssues", () => {
  it("blocks an empty reel", () => {
    expect(codes(emptyTimeline())).toEqual(["empty"]);
    expect(canExport(instagramIssues(emptyTimeline()))).toBe(false);
  });

  it("enforces 3 seconds to 3 minutes", () => {
    expect(codes(addClips(emptyTimeline(), [photo("a", 2999)]))).toEqual(["too-short"]);
    expect(codes(addClips(emptyTimeline(), [photo("a", 3000)]))).toEqual([]);
    expect(codes(addClips(emptyTimeline(), [photo("a", 180_000)]))).toEqual([]);
    expect(codes(addClips(emptyTimeline(), [photo("a", 180_001)]))).toEqual(["too-long"]);
  });

  it("warns, without blocking, about text under Instagram's UI", () => {
    const base = addClips(emptyTimeline(), [photo("a", 5000)]);
    const text = { id: "t", text: "Price", startMs: 0, endMs: 1000, style: "plain" as const, color: "#ffffff", size: 1 };
    const timeline: Timeline = { ...base, texts: [{ ...text, x: 0.5, y: 0.9 }, { ...text, id: "ok", x: 0.5, y: 0.5 }] };
    const issues = instagramIssues(timeline);
    expect(issues).toEqual([expect.objectContaining({ code: "text-unsafe", textId: "t", level: "warning" })]);
    expect(canExport(issues)).toBe(true);
  });

  it("checks the post caption", () => {
    const base = addClips(emptyTimeline(), [photo("a", 5000)]);
    expect(codes(base, "x".repeat(2201))).toEqual(["caption-too-long"]);
    const tags = Array.from({ length: 31 }, (_, index) => `#tag${index}`).join(" ");
    expect(codes(base, tags)).toEqual(["too-many-hashtags"]);
  });
});

describe("helpers", () => {
  it("counts hashtags, including non-Latin ones", () => {
    expect(countHashtags("New listing #realestate #東京 #home_tour, not#this")).toBe(3);
    expect(countHashtags("")).toBe(0);
  });

  it("knows the safe area", () => {
    expect(isInSafeArea(0.5, 0.5)).toBe(true);
    expect(isInSafeArea(0.5, 0.05)).toBe(false);
    expect(isInSafeArea(0.95, 0.5)).toBe(false);
  });
});
