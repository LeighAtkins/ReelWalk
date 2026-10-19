import { describe, expect, it } from "vitest";
import { applyAiEditPlan, clipSchema, emptyTimeline, parseTimeline, singleAiVoice, textSchema, tidyCaptions } from "../src";

const clip = (id: string, volume = 1) => clipSchema.parse({ id, assetId: id, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5000, volume });
const text = (id: string, startMs: number, endMs: number, y: number, extra: Record<string, unknown> = {}) =>
  textSchema.parse({ id, text: id, startMs, endMs, x: 0.5, y, style: "elegant", color: "#ffffff", size: 1, animation: "none", ...extra });
const words = { text: "hi", words: [{ w: "hi", s: 0, e: 400 }] };

describe("caption guards", () => {
  it("keeps captions inside the safe band but leaves stickers and room labels alone", () => {
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("a")], texts: [text("high", 0, 1000, 0.17), text("low", 1000, 2000, 0.8), text("sticker", 0, 1000, 0.17, { style: "tag" }), text("room-kitchen", 0, 1000, 0.9)] });
    const { timeline: tidy, notes } = tidyCaptions(timeline);
    expect(tidy.texts.map((entry) => [entry.id, entry.y])).toEqual([["high", 0.3], ["low", 0.72], ["sticker", 0.17], ["room-kitchen", 0.9]]);
    expect(notes).toEqual(['moved "high" into the safe area', 'moved "low" into the safe area']);
  });

  it("ends a caption when the next one starts on the same line, and drops one that would flash", () => {
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("a")], texts: [text("first", 0, 3000, 0.6), text("second", 1500, 3000, 0.62), text("other line", 1500, 3000, 0.4), text("same start", 1600, 2500, 0.6)] });
    const { timeline: tidy } = tidyCaptions(timeline);
    expect(tidy.texts.find((entry) => entry.id === "first")?.endMs).toBe(1500);
    expect(tidy.texts.find((entry) => entry.id === "other line")?.endMs).toBe(3000);
    // "second" starts 100 ms before "same start" on the same line: too short to read, so it goes.
    expect(tidy.texts.map((entry) => entry.id)).toEqual(["first", "other line", "same start"]);
  });

  it("keeps the first voiced AI take audible and mutes the rest, never real footage", () => {
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("real"), clip("ai-one"), clip("ai-silent"), clip("ai-two")] });
    const assets = { real: { aiGenerated: false, transcript: words }, "ai-one": { aiGenerated: true, transcript: words }, "ai-silent": { aiGenerated: true, transcript: null }, "ai-two": { aiGenerated: true, transcript: words } };
    const { timeline: out, notes } = singleAiVoice(timeline, assets);
    expect(out.clips.map((entry) => entry.volume)).toEqual([1, 1, 1, 0]);
    expect(notes).toEqual(["muted clip 4: only one AI presenter voice plays (clip 2)"]);
    expect(singleAiVoice(out, assets).notes).toEqual([]);
  });

  it("applies after a model edit and tells the user", () => {
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("ai-one"), clip("ai-two")] });
    const assets = { "ai-one": { id: "ai-one", kind: "VIDEO" as const, title: "one", durationMs: 8000, isPano: false, bpm: null, beatOffsetMs: null, aiGenerated: true, transcript: words }, "ai-two": { ...{ id: "ai-two", kind: "VIDEO" as const, title: "two", durationMs: 8000, isPano: false, bpm: null, beatOffsetMs: null }, aiGenerated: true, transcript: words } };
    const result = applyAiEditPlan(timeline, { note: "", ops: [{ op: "addText", content: "Hello", startMs: 0, endMs: 2000, y: 0.1 }] } as never, { assets, songs: [], newId: () => "n" });
    expect(result.timeline.texts[0].y).toBe(0.3);
    expect(result.timeline.clips[1].volume).toBe(0);
    expect(result.applied).toEqual(['added text "Hello"', 'moved "Hello" into the safe area', "muted clip 2: only one AI presenter voice plays (clip 1)"]);
  });
});
