import { describe, expect, it } from "vitest";
import type { Gray } from "./motion";
import { blownRegion, dominantColours, exposureStats, flowResidual, laplacianVariance, rectilinearity, resizeGray, spectralSaliency, stripMotion, strongestCircle } from "./shot-pixels";

const gray = (width: number, height: number, f: (x: number, y: number) => number): Gray => {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { data, width, height };
};
// A deterministic texture.
const noise = (x: number, y: number) => ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
const texture = (x: number, y: number) => 60 + 140 * noise(Math.floor(x / 2), Math.floor(y / 2));

describe("pixel measures", () => {
  it("scores a crisp picture sharper than the same picture blurred", () => {
    const crisp = gray(96, 54, texture);
    const soft = resizeGray(resizeGray(crisp, 24, 14), 96, 54);
    expect(laplacianVariance(crisp)).toBeGreaterThan(laplacianVariance(soft) * 4);
  });
  it("counts crushed and blown pixels", () => {
    const stats = exposureStats(gray(10, 10, (x) => (x < 2 ? 0 : x > 7 ? 255 : 128)));
    expect(stats.clipLow).toBeCloseTo(0.2);
    expect(stats.clipHigh).toBeCloseTo(0.2);
  });
  it("puts the saliency peak on the one thing that stands out", () => {
    const frame = gray(128, 72, (x, y) => (Math.hypot(x - 96, y - 20) < 5 ? 250 : 90 + 4 * Math.sin(x / 9)));
    const peak = spectralSaliency(frame);
    expect(peak.x).toBeCloseTo(96 / 128, 1);
    expect(peak.y).toBeCloseTo(20 / 72, 1);
    expect(peak.strength).toBeGreaterThan(0.2);
  });
  it("finds the strip that moves faster than the background (a near object)", () => {
    const back = (x: number, y: number) => texture(x, y);
    const prev = gray(192, 108, (x, y) => (x >= 96 && x < 120 ? 30 + 20 * noise(x, y) : back(x, y)));
    // Background moves 2 px right; the dark post (now at 108–132) moves 12 px right.
    const next = gray(192, 108, (x, y) => (x >= 108 && x < 132 ? 30 + 20 * noise(x - 12, y) : back(x - 2, y)));
    const strips = stripMotion(prev, next, 12, 16);
    const post = strips[Math.floor(115 / 16)];
    expect(post.shift).toBeGreaterThanOrEqual(8);
    expect(strips[1].shift).toBe(2);
  });
  it("reads a moving subject as residual and a camera move as none", () => {
    const base = gray(96, 54, texture);
    const panned = gray(96, 54, (x, y) => texture(x - 2, y));
    // 2 px over 0.25 s in a 96 px frame is 2/96/0.25 frame widths a second.
    const pan = { tx: 2 / 96 / 0.25, ty: 0, zoom: 0, rotate: 0 };
    expect(flowResidual(base, panned, pan, 0.25)).toBeLessThan(0.1);
    const walker = gray(96, 54, (x, y) => (x > 70 && x < 82 && y > 10 && y < 45 ? 255 - texture(x, y) : texture(x, y)));
    expect(flowResidual(base, walker, { tx: 0, ty: 0, zoom: 0, rotate: 0 }, 0.25)).toBeGreaterThan(0.5);
  });
  it("tells a grid of doors from a round mirror", () => {
    const grid = gray(120, 80, (x, y) => (x % 20 < 2 || y % 20 < 2 ? 220 : 60));
    expect(rectilinearity(grid)).toBeGreaterThan(0.9);
    const mirror = gray(120, 80, (x, y) => (Math.abs(Math.hypot(x - 60, y - 40) - 15) < 1.5 ? 230 : 70));
    const circle = strongestCircle(mirror)!;
    expect(circle.x).toBeCloseTo(0.5, 1);
    expect(circle.y).toBeCloseTo(0.5, 1);
    expect(circle.r).toBeCloseTo(15 / 80, 1);
  });
  it("boxes a blown window and lists dominant colours by share", () => {
    const window = gray(120, 80, (x, y) => (x > 60 && y < 40 ? 255 : 100));
    const blown = blownRegion(window)!;
    expect(blown.x).toBeGreaterThanOrEqual(0.5);
    expect(blown.y).toBe(0);
    const pixels = [...Array(70).fill([200, 30, 30]).flat(), ...Array(30).fill([20, 40, 220]).flat()];
    const colours = dominantColours(pixels, 3);
    expect(colours[0].hex).toBe("#c81e1e");
    expect(colours[0].share).toBeCloseTo(0.7);
  });
});
