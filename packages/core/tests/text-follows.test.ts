import { describe, expect, it } from "vitest";
import { applyAiEditPlan, type AiAsset, type AiEditOp } from "../src/ai-edit";
import { parseTimeline, type Timeline } from "../src/timeline";

// Text stays over the same picture when a video is slowed, sped up or
// trimmed (2026-10-14: "make it 30 s with the same text" slowed one clip to
// half speed and every line stayed at its old second, over a different frame).

const assets: Record<string, AiAsset> = {
  v: { id: "v", kind: "VIDEO", title: "walk", durationMs: 20000, isPano: false, bpm: null, beatOffsetMs: null },
};

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [{ id: "c1", assetId: "v", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 }],
    texts: [
      { id: "a", text: "first", startMs: 1000, endMs: 2000, style: "elegant" },
      { id: "b", text: "second", startMs: 5000, endMs: 7000, style: "elegant" },
    ],
    music: null,
  });
}

const blank: Omit<AiEditOp, "op"> = {
  clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
  volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
  assetId: null, order: null, pieces: null, atClip: null, animation: null, zoom: null, corner: null,
};
const op = (fields: Partial<AiEditOp> & { op: AiEditOp["op"] }): AiEditOp => ({ ...blank, ...fields });
const run = (ops: AiEditOp[], timeline = reel()) => applyAiEditPlan(timeline, { ops, note: "" }, { assets, songs: [], newId: () => "n" });

describe("text follows the picture", () => {
  it("at half speed every line moves to twice its time and lasts twice as long", () => {
    const { timeline } = run([op({ op: "speed", clip: 1, speed: 0.5 })]);
    expect(timeline.texts.map((text) => [text.startMs, text.endMs])).toEqual([
      [2000, 4000],
      [10000, 14000],
    ]);
  });

  it("at double speed the lines come sooner and shorter", () => {
    const { timeline } = run([op({ op: "speed", clip: 1, speed: 2 })]);
    expect(timeline.texts.map((text) => [text.startMs, text.endMs])).toEqual([
      [500, 1000],
      [2500, 3500],
    ]);
  });

  it("trimmed from the start, a line keeps its frame; one cut away shows from the first frame", () => {
    const { timeline } = run([op({ op: "trim", clip: 1, startMs: 1500, endMs: 8000 })]);
    expect(timeline.texts.map((text) => [text.startMs, text.endMs])).toEqual([
      [0, 500],
      [3500, 5500],
    ]);
  });

  it("a photo keeps its offsets when its clip is made longer", () => {
    const photo = parseTimeline({
      ...reel(),
      clips: [{ id: "p", assetId: "v", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 }],
      texts: [{ id: "a", text: "first", startMs: 500, endMs: 1500, style: "elegant" }],
    });
    const { timeline } = run([op({ op: "trim", clip: 1, lengthMs: 6000 })], photo);
    expect(timeline.texts[0]).toMatchObject({ startMs: 500, endMs: 1500 });
  });

  it("times the model set itself on a line are kept, the others still follow", () => {
    const { timeline } = run([op({ op: "speed", clip: 1, speed: 0.5 }), op({ op: "editText", text: 1, startMs: 12000, endMs: 15000 })]);
    expect(timeline.texts.map((text) => [text.startMs, text.endMs])).toEqual([
      [12000, 15000],
      [10000, 14000],
    ]);
  });
});
