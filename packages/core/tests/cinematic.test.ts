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
    expect(textPositionAt(text, 0.25)).toMatchObject({ x: 0.55, y: 0.375 });
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
    expect(next.texts[0]).toMatchObject({ text: "Slow mornings", shadow: "strong", style: "plain", size: 1, startMs: 0, endMs: 1800 });
    expect(next.texts[1]).toMatchObject({ style: "elegant", size: 0.3, shadow: "strong" });
    expect(next.music).toBe(timeline.music);
    expect(timeline.clips[0].motion).toBe("none");
    expect(parseTimeline(next)).toEqual(next);
  });
});

describe("text keyframes", () => {
  it("interpolates scale and rotation along the path and holds after the last point", async () => {
    const { textPositionAt, textSchema } = await import("../src");
    const text = textSchema.parse({ id: "t", text: "Hi", startMs: 0, endMs: 1000, x: 0.5, y: 0.5, path: [{ t: 0, x: 0, y: 0, s: 1, r: 0 }, { t: 1, x: 0.1, y: 0, s: 2, r: 10 }] });
    expect(textPositionAt(text, 0.5)).toEqual({ x: 0.55, y: 0.5, scale: 1.5, rotation: 5 });
    expect(textPositionAt(text, 1)).toEqual({ x: 0.6, y: 0.5, scale: 2, rotation: 10 });
  });
});

describe("pinned text", () => {
  it("runs its path on the clip's source time and holds still on other clips", async () => {
    const { pinnedProgress, PINNED_ELSEWHERE, clipSchema, emptyTimeline, parseTimeline, textSchema } = await import("../src");
    const a = clipSchema.parse({ id: "a", assetId: "wall", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 6000, speed: 2 });
    const b = clipSchema.parse({ id: "b", assetId: "other", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 });
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [b, a] });
    const text = textSchema.parse({ id: "t", text: "Hi", startMs: 0, endMs: 5000, pin: { assetId: "wall", fromMs: 2000, toMs: 4000 }, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.2, y: 0 }] });
    expect(pinnedProgress(timeline, text, 1000)).toBe(PINNED_ELSEWHERE);
    // Clip a starts at 3 s; 0.5 s into it at 2x is source 3000 ms: halfway along the tracked window.
    expect(pinnedProgress(timeline, text, 3500)).toBeCloseTo(0.5);
    // Trimming a's start to 3000 ms moves the same picture earlier in the reel; the pin follows it.
    const trimmed = { ...timeline, clips: [b, { ...a, sourceStartMs: 3000 }] };
    expect(pinnedProgress(trimmed, text, 3000)).toBeCloseTo(0.5);
  });
});
