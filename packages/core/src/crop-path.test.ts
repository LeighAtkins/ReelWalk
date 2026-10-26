import { describe, expect, it } from "vitest";
import { cropJerk, cropWidthFor, reframeCentreAt, reframeShiftAt, smoothCropPath, type CropTarget } from "./crop-path";

const W = cropWidthFor(16 / 9);
const targets = (durationMs: number, x: (t: number) => number, weight = 1): CropTarget[] =>
  Array.from({ length: durationMs / 250 + 1 }, (_, i) => ({ t: i * 250, x: x(i * 250), weight }));

describe("smoothCropPath", () => {
  it("holds still when the target only flickers inside the dead band", () => {
    const keys = smoothCropPath(targets(6000, (t) => 0.5 + (Math.floor(t / 250) % 2 ? 0.02 : -0.02)), { cropWidth: W });
    const xs = keys.map((k) => k.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.01);
  });
  it("follows a jump of attention as a pan with no overshoot, within the speed limit", () => {
    const keys = smoothCropPath(targets(8000, (t) => (t < 3000 ? 0.3 : 0.7)), { cropWidth: W, maxSpeed: 0.12 });
    expect(keys[0].x).toBeCloseTo(0.3, 1);
    expect(keys[keys.length - 1].x).toBeGreaterThan(0.6);
    // Never past the target on either side.
    for (const key of keys) {
      expect(key.x).toBeGreaterThanOrEqual(0.3 - 1e-6);
      expect(key.x).toBeLessThanOrEqual(0.7 + 1e-6);
    }
    for (let i = 1; i < keys.length; i++) expect(Math.abs(keys[i].x - keys[i - 1].x) / ((keys[i].t - keys[i - 1].t) / 1000)).toBeLessThanOrEqual(0.12 + 1e-3);
    // Smooth: no sudden change of speed.
    expect(cropJerk(keys)).toBeLessThan(0.5);
  });
  it("starts moving before the subject does (zero-phase), as an operator would", () => {
    const keys = smoothCropPath(targets(8000, (t) => (t < 4000 ? 0.35 : 0.65)), { cropWidth: W });
    const at = (t: number) => keys.find((k) => k.t === t)!.x;
    expect(at(3500)).toBeGreaterThan(0.36);
    expect(at(4500)).toBeLessThan(0.64);
  });
  it("keeps the crop inside the picture", () => {
    const keys = smoothCropPath(targets(4000, () => 0.02), { cropWidth: W });
    for (const key of keys) expect(key.x).toBeGreaterThanOrEqual(W / 2 - 1e-4);
  });
  it("pulls weak targets toward the centre", () => {
    const strong = smoothCropPath(targets(4000, () => 0.25), { cropWidth: W });
    const weak = smoothCropPath(targets(4000, () => 0.25, 0.2), { cropWidth: W });
    expect(weak[0].x).toBeGreaterThan(strong[0].x);
  });
});

describe("reframeShiftAt", () => {
  const reframe = { aspect: 16 / 9, keys: [{ t: 0, x: 0.2 }, { t: 2000, x: 0.8 }] };
  it("slides the picture so the crop centre sits in the middle of the reel, clamped to the picture", () => {
    // Centre 0.5 → no slide.
    expect(reframeShiftAt({ aspect: 16 / 9, keys: [{ t: 0, x: 0.5 }] }, 0)).toBeCloseTo(0);
    // Far left is clamped to the crop's half width: the picture's left edge on the reel's left edge.
    const scale = (16 / 9) / (9 / 16);
    expect(reframeShiftAt({ aspect: 16 / 9, keys: [{ t: 0, x: 0 }] }, 0)).toBeCloseTo((0.5 - W / 2) * scale * 100);
    expect(reframeCentreAt(reframe, 1000)).toBeCloseTo(0.5, 5);
    expect(reframeShiftAt(reframe, 3000)).toBeLessThan(0);
  });
  it("does nothing for a source no wider than the reel", () => {
    expect(reframeShiftAt({ aspect: 9 / 16, keys: [{ t: 0, x: 0.2 }] }, 0)).toBe(0);
  });
});
