import { describe, expect, it } from "vitest";
import { applyCommand, clipDurationMs, clipSchema, clipStartsMs, emptyTimeline, fitCutTo, parseTimeline, placeDropOnCut, textSchema, type Timeline } from "../src";

const clip = (id: string, ms: number, extra: Record<string, unknown> = {}) => clipSchema.parse({ id, assetId: id, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: ms, ...extra });
const photo = (id: string, ms: number) => clipSchema.parse({ id, assetId: id, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: ms });

const own = (): Timeline => parseTimeline({ ...emptyTimeline(), clips: [clip("a", 2000), clip("b", 3000), clip("c", 2000)], music: { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 120, beatOffsetMs: 0 } });
const instagram = (): Timeline => parseTimeline({ ...emptyTimeline(), clips: [clip("a", 2000), photo("b", 3000), clip("c", 2000)], music: { assetId: "song", instagramAudioId: "9", volume: 0.8, bpm: 120, beatOffsetMs: 0 } });

describe("placeDropOnCut", () => {
  it("moves your own song so the drop lands on the cut, and records it", () => {
    const placed = placeDropOnCut(own(), 2, 12_000);
    expect(placed.music!.sourceStartMs).toBe(7000);
    expect(placed.music!.drop).toEqual({ songMs: 12_000, cutIndex: 2 });
    expect(placed.clips).toEqual(own().clips);
  });

  it("moves the cut instead for an Instagram sound, which always plays from its start", () => {
    const sources = { a: 6000, c: 6000 };
    const placed = placeDropOnCut(instagram(), 2, 6000, sources);
    expect(clipStartsMs(placed)[2]).toBe(6000);
    expect(placed.music!.sourceStartMs).toBe(0);
    expect(placed.music!.drop).toEqual({ songMs: 6000, cutIndex: 2 });
    // Scaled evenly: 2 s and 3 s become 2.4 s and 3.6 s; the clip after the cut is untouched.
    expect(placed.clips.map(clipDurationMs)).toEqual([2400, 3600, 2000]);
  });

  it("moves the cut for your own song too when the drop comes before the cut could be reached", () => {
    const placed = placeDropOnCut(own(), 2, 4000, { a: 6000, b: 6000 });
    expect(placed.music!.sourceStartMs).toBe(0);
    expect(clipStartsMs(placed)[2]).toBe(4000);
  });

  it("respects each video's source and the shortest clip, and gives up when it cannot fit", () => {
    // a has only 2.5 s of source: the photo takes the rest of the stretch.
    const placed = placeDropOnCut(instagram(), 2, 7000, { a: 2500 });
    expect(placed.clips.map(clipDurationMs)).toEqual([2500, 4500, 2000]);
    // Nothing can be made shorter than 500 ms: a drop at 0.6 s on cut 2 is impossible.
    const base = instagram();
    expect(placeDropOnCut(base, 2, 600, {})).toBe(base);
    expect(fitCutTo(base.clips, 2, 600, {})).toBeNull();
    expect(placeDropOnCut(base, 0, 6000)).toBe(base);
    expect(placeDropOnCut(base, 3, 6000)).toBe(base);
  });

  it("goes through the command layer as one step, moving titles with their clips", () => {
    const timeline: Timeline = { ...instagram(), texts: [textSchema.parse({ id: "t", text: "Hi", startMs: 2500, endMs: 4000, x: 0.5, y: 0.5 })] };
    const result = applyCommand(parseTimeline(timeline), { type: "dropOnCut", cut: 2, dropSongMs: 6000 }, { generation: 1, sourceDurationsMs: { a: 6000 } });
    expect(result.rejected).toBeUndefined();
    expect(clipStartsMs(result.timeline)[2]).toBe(6000);
    // The title sat 500 ms into the photo; it still starts inside it.
    expect(result.timeline.texts[0].startMs).toBeGreaterThanOrEqual(2400);
    expect(result.changes.some((change) => change.kind === "music")).toBe(true);
    const bad = applyCommand(parseTimeline(timeline), { type: "dropOnCut", cut: 5, dropSongMs: 6000 }, { generation: 1 });
    expect(bad.rejected).toMatch(/no cut 5/);
  });
});
