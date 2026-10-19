import { describe, expect, it } from "vitest";
import { clipSchema, duckGain, emptyTimeline, parseTimeline, speechWindows } from "../src";

const clip = (id: string, extra: Record<string, unknown> = {}) => clipSchema.parse({ id, assetId: id, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, ...extra });
const talk = { text: "hello there friend", words: [{ w: "hello", s: 1000, e: 1300 }, { w: "there", s: 1400, e: 1700 }, { w: "friend", s: 3000, e: 3400 }] };

describe("music ducking from transcripts", () => {
  it("finds speech in reel time, merges close words, pads, and skips muted clips", () => {
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("quiet", { volume: 0 }), clip("talk")] });
    const windows = speechWindows(timeline, { quiet: talk, talk });
    // The talking clip starts at 4 s: words at 1.0–1.7 s merge (gap 100 ms), 3.0–3.4 s stands alone; 150 ms padding each side.
    expect(windows).toEqual([{ startMs: 4850, endMs: 5850 }, { startMs: 6850, endMs: 7550 }]);
  });

  it("follows a trim and a speed change", () => {
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("talk", { sourceStartMs: 1200, sourceEndMs: 3200, speed: 2 })] });
    // "hello" is mostly cut (100 ms left, under its half), "there" plays at 100–350 ms source → 100–250 ms reel, "friend" is trimmed to 3000–3200 → 900–1000 ms reel.
    expect(speechWindows(timeline, { talk })).toEqual([{ startMs: 0, endMs: 400 }, { startMs: 750, endMs: 1150 }]);
  });

  it("eases the music down before a line and back up after it", () => {
    const windows = [{ startMs: 1000, endMs: 2000 }];
    expect(duckGain(windows, 500)).toBe(1);
    expect(duckGain(windows, 875)).toBeCloseTo(0.65);
    expect(duckGain(windows, 1500)).toBe(0.3);
    expect(duckGain(windows, 2125)).toBeCloseTo(0.65);
    expect(duckGain(windows, 2300)).toBe(1);
    expect(duckGain([], 1500)).toBe(1);
  });
});
