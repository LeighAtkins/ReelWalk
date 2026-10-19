import { describe, expect, it } from "vitest";
import { clipSchema, emptyTimeline, hookSchema, parseTimeline, setHook, wordsBehindHook } from "../src";

const clip = clipSchema.parse({ id: "a", assetId: "a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5000 });

describe("visual hooks", () => {
  it("stores a drawn hook on the timeline with defaults, and removes it", () => {
    const timeline = setHook(parseTimeline({ ...emptyTimeline(), clips: [clip] }), hookSchema.parse({ kind: "alert", title: "Price drop" }));
    expect(timeline.hook).toMatchObject({ kind: "alert", title: "Price drop", durationMs: 2200, font: "sans" });
    expect(parseTimeline(timeline).hook?.kind).toBe("alert");
    expect(setHook(timeline, null).hook).toBeNull();
    expect(parseTimeline({ ...emptyTimeline(), clips: [clip] }).hook).toBeNull();
  });

  it("writes three staggered extruded words behind the person over the first shot, replacing earlier ones", () => {
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [clip] });
    const once = wordsBehindHook(timeline, ["THIS", "HOUSE", "SOLD"]);
    expect(once.texts.map((t) => [t.text, t.startMs, t.endMs, t.behind, t.depth])).toEqual([["THIS", 0, 3200, true, "extruded"], ["HOUSE", 500, 3200, true, "extruded"], ["SOLD", 1000, 3200, true, "extruded"]]);
    const again = wordsBehindHook(once, ["NEW"]);
    expect(again.texts.map((t) => t.text)).toEqual(["NEW"]);
    expect(wordsBehindHook(parseTimeline(emptyTimeline()), ["X"]).texts).toEqual([]);
  });
});
