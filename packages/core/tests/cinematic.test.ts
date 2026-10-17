import { describe, expect, it } from "vitest";
import { cameraMoveAt, clipSchema, emptyTimeline, luxuryFinish, parseTimeline, textPositionAt, textSchema, timelineDurationMs } from "../src";

describe("cinematic edit finish", () => {
  it("completes a snap in 180 ms, holds its crop, and never exposes a border", () => {
    expect(cameraMoveAt("snap-in", 0, 0).scale).toBe(1);
    expect(cameraMoveAt("snap-in", 0.5, 0.18).scale).toBe(1.12);
    expect(cameraMoveAt("snap-in", 1, 5).scale).toBe(1.12);
    expect(cameraMoveAt("snap-out", 1, 5).scale).toBe(1);
    for (const seconds of [-1, 0, 0.05, 0.1, 0.18, 2]) expect(cameraMoveAt("snap-out", 0.5, seconds).scale).toBeGreaterThanOrEqual(1);
  });
  it("interpolates tracked text offsets and retains movement when the text is dragged", () => {
    const text = textSchema.parse({ id: "title", text: "The terrace", startMs: 0, endMs: 2000, x: 0.5, y: 0.4,
      path: [{ t: 0, x: 0, y: 0 }, { t: 0.5, x: 0.1, y: -0.05 }, { t: 1, x: 0.2, y: -0.1 }] });
    expect(textPositionAt(text, 0.25)).toEqual({ x: 0.55, y: 0.375 });
    expect(textPositionAt({ ...text, x: 0.3 }, 1).x).toBeCloseTo(0.5);
    expect(textPositionAt({ ...text, x: 0.3 }, 1).y).toBeCloseTo(0.3);
    expect(textPositionAt(text, 10).x).toBe(0.7);
    expect(textSchema.safeParse({ ...text, path: [{ t: 1, x: 0, y: 0 }, { t: 0, x: 0, y: 0 }] }).success).toBe(false);
  });
  it("keeps source clips, timing, captions and music while applying an editable finish", () => {
    const clip = clipSchema.parse({ id: "a", assetId: "original", kind: "VIDEO", sourceStartMs: 500, sourceEndMs: 2500 });
    const timeline = { ...emptyTimeline(), clips: [clip, clipSchema.parse({ ...clip, id: "b", transitionIn: "whip", whipDirection: "left" })], texts: [textSchema.parse({ id: "t", text: "Slow mornings", startMs: 0, endMs: 1800 }), textSchema.parse({ id: "small", text: "A private retreat", style: "elegant", size: 0.3, startMs: 2000, endMs: 4000 })] };
    const next = luxuryFinish(timeline);
    expect(timelineDurationMs(next)).toBe(timelineDurationMs(timeline));
    expect(next.clips.map(c => c.assetId)).toEqual(["original", "original"]);
    expect(next.clips[0]).toMatchObject({ motion: "snap-out", lensSoftness: 0.28, filter: "golden" });
    expect(next.clips[1].motion).toBe("none");
    expect(next.clips[1].transitionIn).toBe("cut");
    expect(next.texts[0]).toMatchObject({ text: "Slow mornings", font: "sans", tracking: 0, style: "plain", size: 1.4, animation: "none", startMs: 0, endMs: 1800 });
    expect(next.music).toBe(timeline.music);
    expect(timeline.clips[0].motion).toBe("none");
    expect(parseTimeline(next)).toEqual(next);
  });
});
