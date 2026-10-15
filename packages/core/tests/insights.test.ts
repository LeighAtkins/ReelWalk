import { describe, expect, it } from "vitest";
import { insightsLine } from "../src";

const none = { views: null, reach: null, likes: null, comments: null, saved: null, shares: null, avgWatchMs: null };

describe("insightsLine", () => {
  it("reads like a sentence, with thousands separators and seconds", () => {
    expect(insightsLine({ views: 1204, reach: 980, likes: 41, comments: 6, saved: 1, shares: 3, avgWatchMs: 3240 })).toBe(
      "1,204 views · 980 reached · 3.2 s average watch · 41 likes · 6 comments · 1 save · 3 shares",
    );
  });
  it("keeps zero views and reach but drops zero likes and the rest", () => {
    expect(insightsLine({ ...none, views: 0, reach: 0, likes: 0, comments: 0 })).toBe("0 views · 0 reached");
    expect(insightsLine({ ...none, views: 1, likes: 1 })).toBe("1 view · 1 like");
  });
  it("says so when there is nothing", () => {
    expect(insightsLine(none)).toBe("No numbers yet");
  });
});
