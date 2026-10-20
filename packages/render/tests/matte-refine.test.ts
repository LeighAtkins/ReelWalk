import { describe, expect, it } from "vitest";
import { blend, boundingBox, grow, guidedFilter, paste, resample, toAlpha, type Mask } from "../src/reel/matte-refine";

const make = (width: number, height: number, f: (x: number, y: number) => number): Mask => {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { data, width, height };
};

describe("matte refinement", () => {
  it("finds the person's box and grows the mask by a pixel", () => {
    const m = make(20, 20, (x, y) => (x >= 5 && x < 10 && y >= 8 && y < 15 ? 1 : 0));
    expect(boundingBox(m)).toEqual({ x0: 5, y0: 8, x1: 10, y1: 15 });
    expect(boundingBox(make(4, 4, () => 0))).toBeNull();
    const g = grow(m, 1);
    expect(g.data[8 * 20 + 4]).toBe(1); expect(g.data[7 * 20 + 5]).toBe(1); expect(g.data[6 * 20 + 5]).toBe(0);
  });

  it("snaps a blurred mask edge onto the picture's edge", () => {
    const width = 64, height = 16;
    const guide = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) guide[y * width + x] = x < 32 ? 0.2 : 0.8;
    const soft = make(width, height, (x) => Math.max(0, Math.min(1, (x - 24) / 16)));
    const out = guidedFilter(soft, guide, 4, 1e-3);
    const row = (m: Mask, x: number) => m.data[8 * width + x];
    expect(row(out, 29)).toBeLessThan(row(soft, 29) - 0.05); expect(row(out, 34)).toBeGreaterThan(row(soft, 34) + 0.05);
    expect(row(out, 29)).toBeLessThan(0.3); expect(row(out, 34)).toBeGreaterThan(0.65);
  });

  it("blends toward the previous frame, resamples, pastes and converts to alpha", () => {
    const a = make(4, 4, () => 1), b = make(4, 4, () => 0);
    expect(blend(a, b, 0.25).data[0]).toBeCloseTo(0.75, 6);
    expect(blend(a, null).data[0]).toBe(1);
    const up = resample(make(2, 2, (x) => x), 4, 2);
    expect(up.data[0]).toBeLessThan(up.data[3]);
    const pasted = paste(make(2, 2, () => 1), 4, 4, 1, 1);
    expect(pasted.data[1 * 4 + 1]).toBe(1); expect(pasted.data[0]).toBe(0);
    const alpha = toAlpha(make(3, 1, (x) => [0.2, 0.46, 0.9][x]), 0.3, 0.6);
    expect([...alpha]).toEqual([0, 136, 255]);
  });
});
