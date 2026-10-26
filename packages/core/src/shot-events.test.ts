import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { applyReframes, reframeFromAnalysis } from "./reframe";
import { brightnessRamps, closeUpBox, closeUpWindows, detectOccluders, steadiness, type StripSample } from "./shot-events";
import type { Strip } from "./shot-pixels";
import { clipPicture, clipMomentAtSource, compositionToSource, sourceToComposition } from "./view";
import { emptyTimeline, type Clip, type Timeline } from "./timeline";

const strip = (shift: number, luma = 0.5, texture = 100): Strip => ({ shift, luma, texture });

describe("detectOccluders", () => {
  it("finds a near post sweeping right across a slow pan, with its span and leading edge", () => {
    // Twelve strips; the background drifts 1 px right; a dark fast band enters at the left and leaves at the right.
    const series: StripSample[] = Array.from({ length: 10 }, (_, i) => ({
      t: i * 250,
      width: 192,
      strips: Array.from({ length: 12 }, (_, s) => (s >= i * 1.2 && s < i * 1.2 + 3 ? strip(9, 0.15, 10) : strip(1))),
    }));
    const [occluder] = detectOccluders(series);
    expect(occluder.direction).toBe("right");
    expect(occluder.near).toBe(true);
    expect(occluder.coverage).toBeGreaterThanOrEqual(0.25);
    expect(occluder.edgeTo).toBeGreaterThan(occluder.edgeFrom);
    expect(occluder.startMs).toBe(0);
  });
  it("follows a soft wall leaving on one side apart from a still dark wall on the other", () => {
    // Strips 0–1 a still dark wall; a soft teal wall covers 9–11 and shrinks out to the right.
    const series: StripSample[] = Array.from({ length: 8 }, (_, i) => ({
      t: i * 250,
      width: 192,
      strips: Array.from({ length: 12 }, (_, s) => (s < 2 ? strip(0, 0.1, 2) : s >= 9 + Math.floor(i / 3) ? strip(0, 0.32, 2) : strip(0, 0.55, 600))),
    }));
    const found = detectOccluders(series);
    expect(found).toHaveLength(1);
    expect(found[0].direction).toBe("right");
    expect(found[0].edgeFrom).toBeLessThan(0.8);
  });
  it("ignores a dark band that never moves (a vignette or a fixed frame edge)", () => {
    const series: StripSample[] = Array.from({ length: 10 }, (_, i) => ({ t: i * 250, width: 192, strips: Array.from({ length: 12 }, (_, s) => (s < 3 ? strip(0, 0.1, 5) : strip(0))) }));
    expect(detectOccluders(series)).toEqual([]);
  });
});

describe("events", () => {
  it("scores a smooth glide steady and shake unsteady", () => {
    const glide = steadiness(Array.from({ length: 12 }, () => ({ dx: 0.08, dy: 0 })));
    const shake = steadiness(Array.from({ length: 12 }, (_, i) => ({ dx: i % 2 ? 0.2 : -0.2, dy: 0 })));
    expect(Math.min(...glide)).toBeGreaterThan(0.95);
    expect(Math.max(...shake.slice(2, -2))).toBeLessThan(0.2);
  });
  it("finds the lights coming on", () => {
    const samples = Array.from({ length: 24 }, (_, i) => ({ t: i * 250, luma: i < 10 ? 0.2 : i < 14 ? 0.2 + (i - 9) * 0.08 : 0.55 }));
    const [ramp] = brightnessRamps(samples);
    expect(ramp.kind).toBe("up");
    expect(ramp.startMs).toBeGreaterThanOrEqual(2000);
    expect(ramp.endMs).toBeLessThanOrEqual(4000);
  });
  it("only offers a close-up with 720 real pixels", () => {
    expect(closeUpBox(1920, 1080, 0.5, 0.5)).toBeNull();
    expect(closeUpBox(3840, 2160, 0.5, 0.5)).toEqual(expect.objectContaining({ w: 0.188 }));
    const box = closeUpBox(1080, 1920, 0.9, 0.1)!;
    expect(box.x + box.w).toBeLessThanOrEqual(1);
    const readings = Array.from({ length: 10 }, (_, i) => ({ t: i * 250, box, sharpness: 0.7, saliency: 0.6, steady: 0.9 }));
    expect(closeUpWindows(readings, 1080)).toEqual([expect.objectContaining({ startMs: 0, endMs: 2500, sourcePx: 720 })]);
  });
});

describe("the reframe on the timeline", () => {
  const wide = { width: 1920, height: 1080, reframe: { aspect: 16 / 9, cropWidth: 0.3164, path: [{ t: 0, x: 0.3, y: 0.5 }, { t: 4000, x: 0.6, y: 0.5 }], closeUps: [] } };
  const video = (id: string, assetId: string): Clip => ({ id, assetId, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, speed: 1, volume: 1, fit: "cover", filter: "none", motion: "none", pano: null, spot: null, room: null, transitionIn: "cut", zoom: 1 });
  const timeline: Timeline = { ...emptyTimeline(), clips: [video("a", "wide"), video("b", "tall")] };

  it("turns on for wide sources only, and leaves a clip that has one alone", () => {
    const out = applyReframes(timeline, { wide, tall: { width: 1080, height: 1920, reframe: null } });
    expect(out.clips[0].reframe?.keys[0]).toEqual({ t: 0, x: 0.3 });
    expect(out.clips[1].reframe).toBeUndefined();
    expect(applyReframes(out, { wide: { ...wide, reframe: { ...wide.reframe, path: [{ t: 0, x: 0.9, y: 0.5 }] } } }).clips[0].reframe?.keys[0].x).toBe(0.3);
  });
  it("is set and cleared by the setReframe command", () => {
    const on = applyCommand(timeline, { type: "setReframe", clipId: "a", reframe: "auto", analysis: wide }, { generation: 0 });
    expect(on.timeline.clips[0].reframe).toEqual(reframeFromAnalysis(wide));
    const off = applyCommand(on.timeline, { type: "setReframe", clipId: "a", reframe: null }, { generation: 1 });
    expect(off.timeline.clips[0].reframe).toBeUndefined();
    expect(applyCommand(timeline, { type: "setReframe", clipId: "b", reframe: "auto", analysis: { width: 1080, height: 1920, reframe: null } }, { generation: 0 }).rejected).toBeTruthy();
  });
  it("moves the frame service's mapping with the picture, both ways", () => {
    const clip = applyReframes(timeline, { wide }).clips[0];
    const moment = clipMomentAtSource(clip, 0);
    const picture = clipPicture(clip, { width: 1920, height: 1080 }, moment);
    // The crop is centred on x 0.3 of the source: that column lands in the middle of the reel.
    expect(sourceToComposition(picture, 0.3 * 1920, 540)[0]).toBeCloseTo(0.5, 3);
    const [px] = compositionToSource(picture, 0.5, 0.5);
    expect(px).toBeCloseTo(0.3 * 1920, 0);
  });
});
