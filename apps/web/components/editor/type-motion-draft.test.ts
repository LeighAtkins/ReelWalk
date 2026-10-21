import { describe, expect, it } from "vitest";
import type { TextOverlay } from "@reelwalk/core";
import { asCallout, beatForMotion, motionMode, motionStartMs, withMotionMode, withMotionStartAt } from "./type-motion-draft";

type D = Pick<TextOverlay, "shine" | "kinetic">;
const d = (draft: D): D => draft;

describe("the text sheet's Motion row (ADR 0061)", () => {
  it("holds one kind at a time and keeps a preset already chosen", () => {
    const shine = withMotionMode(d({}), "shine");
    expect(shine).toEqual({ kinetic: undefined, shine: { preset: "sweep" } });
    expect(motionMode(shine)).toBe("shine");
    const kinetic = withMotionMode(shine, "kinetic");
    expect(kinetic.shine).toBeUndefined();
    expect(kinetic.kinetic).toEqual({ preset: "words" });
    expect(withMotionMode(d({ kinetic: { preset: "count" } }), "kinetic").kinetic).toEqual({ preset: "count" });
    expect(withMotionMode(kinetic, "none")).toEqual({ shine: undefined, kinetic: undefined });
    expect(motionMode({})).toBe("none");
  });

  it("starts the motion on the frame the playhead is on, inside the text", () => {
    const title = { startMs: 2000, endMs: 4000 };
    expect(motionStartMs({ shine: { preset: "sweep" } })).toBe(400);
    expect(withMotionStartAt(d({ shine: { preset: "sweep" } }), 2510, title).shine!.startMs).toBe(500);
    expect(withMotionStartAt(d({ kinetic: { preset: "count" } }), 1000, title).kinetic!.startMs).toBe(0);
    expect(withMotionStartAt(d({ kinetic: { preset: "count" } }), 9000, title).kinetic!.startMs).toBe(1999);
  });

  it("finds the beat for the motion when the music has a tempo", () => {
    const music = { bpm: 120, beatOffsetMs: 0, sourceStartMs: 0 };
    expect(beatForMotion({ shine: { preset: "sweep" } }, { startMs: 2000 }, music)).toBe(2500);
    expect(beatForMotion({ kinetic: { preset: "words" } }, { startMs: 2100 }, music)).toBe(2500);
    expect(beatForMotion({ shine: { preset: "sweep" } }, { startMs: 2000 }, { ...music, bpm: null })).toBeNull();
    expect(beatForMotion({}, { startMs: 2000 }, music)).toBeNull();
  });

  it("a callout starts as a small white label", () => {
    const draft = asCallout({ style: "headline" as const, size: 1.4, animation: "pop" as const });
    expect(draft).toMatchObject({ style: "box", size: 0.6, animation: "auto", callout: { x: 0.4, y: 0.64 } });
  });
});
