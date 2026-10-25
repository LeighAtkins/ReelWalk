import { describe, expect, it } from "vitest";
import { presentGray, trackSampling, trackTitleFromFrames, type Clip, type Gray, type Quad } from "../src";
import { px, render, W, H } from "./surface-synth";

const clip = (patch: Partial<Clip> = {}): Clip => ({ id: "c", assetId: "a", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 3000, speed: 1, volume: 1, fit: "cover", filter: "none", motion: "none", zoom: 1, pano: null, spot: null, room: null, transitionIn: "cut", ...patch } as Clip);
const source = (w: number, h: number, f: (x: number, y: number) => number): Gray => ({ data: Float32Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w))), width: w, height: h });

describe("trackSampling", () => {
  it("samples a title's whole shot evenly, at most 63 frames", () => {
    const s = trackSampling(clip(), 0, { startMs: 0, endMs: 2000 });
    if ("error" in s) throw new Error(s.error);
    expect(s.fromMs).toBe(1000); expect(s.toMs).toBe(3000);
    expect(s.times.length).toBeLessThanOrEqual(63);
    expect(s.times[0]).toBe(1000); expect(s.times.at(-1)).toBe(3000);
    const gaps = s.times.slice(1).map((t, i) => t - s.times[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-6);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(s.stepMs + 1e-6);
  });
  it("follows the clip's speed and where the title starts in it", () => {
    const s = trackSampling(clip({ speed: 2, sourceStartMs: 0, sourceEndMs: 4000 }), 500, { startMs: 1000, endMs: 2500 });
    if ("error" in s) throw new Error(s.error);
    expect(s.fromMs).toBe(1000); // (1000 − 500) ms into the clip at 2× is 1000 ms of source
    expect(s.toMs).toBe(4000);
  });
  it("refuses a title on screen too briefly", () => {
    expect("error" in trackSampling(clip(), 0, { startMs: 0, endMs: 150 })).toBe(true);
  });
});

describe("presentGray", () => {
  it("draws a 9:16 source as it is, at the tracker's size", () => {
    const src = source(1080, 1920, (x, y) => (x / 1080) * 200 + (y / 1920) * 50);
    const out = presentGray(src, clip(), 1500);
    expect(out.width).toBe(360); expect(out.height).toBe(640);
    expect(out.data[320 * 360 + 180]).toBeCloseTo(0.5 * 200 + 0.5 * 50, 0);
    expect(out.data[10 * 360 + 10]).toBeCloseTo((10.5 / 360) * 200 + (10.5 / 640) * 50, 0);
  });
  it("covers the frame with the middle of a landscape source (Fill) and puts it on flat grey with room round it (Fit)", () => {
    const src = source(1280, 720, (x) => (x < 640 ? 60 : 200));
    const fill = presentGray(src, clip({ fit: "cover" }), 1500);
    // The centre column of the crop is the source's centre: the step sits at x = 180.
    expect(fill.data[320 * 360 + 170]).toBe(60); expect(fill.data[320 * 360 + 190]).toBe(200);
    expect(fill.data[0]).not.toBe(128);
    const fit = presentGray(src, clip({ fit: "contain" }), 1500);
    expect(fit.data[5 * 360 + 180]).toBe(128); // above the picture
    expect(fit.data[635 * 360 + 180]).toBe(128); // below it
    expect([60, 200]).toContain(Math.round(fit.data[320 * 360 + 100]));
  });
  it("crops to the middle when zoomed", () => {
    const src = source(1080, 1920, (x) => x);
    const zoomed = presentGray(src, clip({ zoom: 2 }), 1500);
    // The left edge of the zoomed frame shows source x = 270 (a quarter in).
    expect(zoomed.data[320 * 360]).toBeCloseTo(270.25, 0);
    expect(zoomed.data[320 * 360 + 359]).toBeCloseTo(808.75, 0);
  });
});

describe("trackTitleFromFrames", () => {
  // A textured wall that slides 1.2 px a frame to the left across twenty frames, in front of a still background.
  const wall = [0.18, 0.3, 0.82, 0.3, 0.82, 0.55, 0.18, 0.55];
  const frames = Array.from({ length: 20 }, (_, k) => {
    const dx = -1.2 * k;
    return render([{ quad: px(wall).map((v, i) => (i % 2 === 0 ? v + dx : v)) as Quad, base: 170, seed: 5, stick: true }], { base: 70, seed: 9 });
  });
  const times = frames.map((_, k) => 1000 + (2000 * k) / 19);
  const title = { x: 0.5, y: 0.425, startMs: 0, endMs: 2000, surface: [0.28, 0.35, 0.72, 0.35, 0.72, 0.5, 0.28, 0.5] };

  it("follows a moving surface and saves the corners of every keyframe", async () => {
    const result = await trackTitleFromFrames({ frames, times, assetId: "a", clip: clip(), clipStartMs: 0, text: title });
    if ("error" in result) throw new Error(result.error);
    expect(result.quality.grade).toBe("good");
    expect(result.pin.assetId).toBe("a");
    expect(result.path[0].t).toBe(0); expect(result.path.at(-1)!.t).toBe(1);
    // The last keyframe's left edge is where the surface moved to: 19 × 1.2 px left of its start, at 360 wide.
    const first = result.path[0].q!, last = result.path.at(-1)!.q!;
    expect((first[0] - last[0]) * W).toBeGreaterThan(19 * 1.2 - 1.5);
    expect((first[0] - last[0]) * W).toBeLessThan(19 * 1.2 + 1.5);
  });

  it("takes features from a wider area on the same wall, so a title on a plain part of a textured wall can be followed", async () => {
    // The title sits on a blank panel of the wall; the wall round it has the detail.
    const bare = (k: number) => {
      const f = frames[k];
      const data = Float32Array.from(f.data);
      for (let y = Math.round(0.35 * H); y < 0.5 * H; y++) for (let x = Math.round((0.28 + dxFraction(k)) * W); x < (0.72 + dxFraction(k)) * W; x++) data[y * W + x] = 170;
      return { data, width: W, height: H };
    };
    const dxFraction = (k: number) => (-1.2 * k) / W;
    const blank = frames.map((_, k) => bare(k));
    const alone = await trackTitleFromFrames({ frames: blank, times, assetId: "a", clip: clip(), clipStartMs: 0, text: title });
    expect("error" in alone).toBe(true);
    const wide = await trackTitleFromFrames({ frames: blank, times, assetId: "a", clip: clip(), clipStartMs: 0, text: { ...title, support: wall } });
    if ("error" in wide) throw new Error(wide.error);
    expect(wide.quality.grade).not.toBe("lost");
  });

  it("says why when it cannot follow", async () => {
    const flat = frames.map(() => ({ data: new Float32Array(W * H).fill(120), width: W, height: H }));
    const result = await trackTitleFromFrames({ frames: flat, times, assetId: "a", clip: clip(), clipStartMs: 0, text: title });
    expect("error" in result && result.error).toMatch(/Could not follow this surface/);
  });
});
