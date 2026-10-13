import { describe, expect, it } from "vitest";
import { currentLook, currentPace, formatArea, formatPrice, retime, retimeToLength, setClipRoom, setLook } from "../src/review";
import { clipDurationMs, parseTimeline, timelineDurationMs } from "../src/timeline";

function reel() {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "photo", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000, room: "exterior" },
      { id: "c2", assetId: "video", kind: "VIDEO", sourceStartMs: 4000, sourceEndMs: 6000, room: "kitchen" },
      { id: "c3", assetId: "photo2", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000, room: "pool" },
    ],
    texts: [{ id: "t1", text: "Over the kitchen", startMs: 2500, endMs: 3500 }],
    music: null,
  });
}
const durations = { video: 10000 };

describe("retime", () => {
  it("gives every shot the pace, keeps a video's middle, and moves texts with their pictures", () => {
    const slower = retime(reel(), 4000, durations);
    expect(slower.clips.map(clipDurationMs)).toEqual([4000, 4000, 4000]);
    // The video showed 4–6 s; four seconds around its middle is 3–7 s.
    expect(slower.clips[1]).toMatchObject({ sourceStartMs: 3000, sourceEndMs: 7000 });
    // The text sat 0.5 s into the kitchen shot, and still does.
    expect(slower.texts[0]).toMatchObject({ startMs: 4500, endMs: 5500 });
    expect(currentPace(slower)).toBe("slower");
  });

  it("a video cannot play more than its source", () => {
    const slow = retime(reel(), 4000, { video: 3000 });
    expect(clipDurationMs(slow.clips[1])).toBe(3000);
  });

  it("brings the reel to a length", () => {
    expect(timelineDurationMs(retimeToLength(reel(), 15000, durations))).toBe(15000);
    expect(timelineDurationMs(retimeToLength(reel(), 30000, durations))).toBe(15000); // 5 s a shot at most
  });
});

describe("look and rooms", () => {
  it("one look for every clip", () => {
    const warm = setLook(reel(), "warm");
    expect(currentLook(warm)).toBe("warm");
    expect(currentLook(reel())).toBe("none");
  });

  it("a room changed by the studio redraws the room labels", () => {
    const labelled = parseTimeline({ ...reel(), texts: [{ id: "room-c2", text: "Kitchen", startMs: 2200, endMs: 4000 }] });
    const next = setClipRoom(labelled, "c2", "dining room");
    expect(next.clips[1].room).toBe("dining room");
    expect(next.texts.find((text) => text.id === "room-c2")?.text).toBe("Dining room");
  });
});

describe("formatting the facts", () => {
  it("adds $ and sq ft to bare numbers, and leaves typed ones alone", () => {
    expect(formatPrice("1240000")).toBe("$1,240,000");
    expect(formatPrice("1,240,000")).toBe("$1,240,000");
    expect(formatPrice("$1.2M")).toBe("$1.2M");
    expect(formatPrice("Offers over 1M")).toBe("Offers over 1M");
    expect(formatArea("2400")).toBe("2,400 sq ft");
    expect(formatArea("2,400 sqft")).toBe("2,400 sqft");
    expect(formatArea("")).toBe("");
  });
});
