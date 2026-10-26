import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bestWindows,
  cutEyeTrace,
  describeShotAnalysis,
  digestShotAnalysis,
  eyeTraceDistance,
  flowDirection,
  flowPeaks,
  motionSegments,
  parseShotAnalysis,
  shotAnalysisSchema,
  toReelPoint,
  EDGE_GUARD_MS,
  EYE_TRACE_LIMIT,
  type ShotAnalysis,
  type ShotSample,
} from "./shot-analysis";

const sample = (t: number, over: Partial<ShotSample> & { dx?: number; dy?: number; zoom?: number; rotate?: number } = {}): ShotSample => {
  const { dx = 0.05, dy = 0, zoom = 0, rotate = 0, ...rest } = over;
  return {
    t, sharpness: 0.6, clipLow: 0, clipHigh: 0, luma: 0.5, steady: 0.9,
    flow: { dx, dy, zoom, rotate, magnitude: Math.max(Math.hypot(dx, dy), Math.abs(zoom) / 2, Math.abs(rotate) / 2), residual: 0.05 },
    saliency: { x: 0.5, y: 0.5, strength: 0.5 },
    ...rest,
  };
};
const clip = (durationMs: number, at: (t: number) => Partial<ShotSample> & { dx?: number; dy?: number; zoom?: number } = () => ({})) =>
  Array.from({ length: Math.floor(durationMs / 250) }, (_, i) => sample(i * 250, at(i * 250)));

describe("flowDirection", () => {
  it("names content motion the way the eye follows it", () => {
    expect(flowDirection({ dx: 0.08, dy: 0, zoom: 0 })).toBe("right");
    expect(flowDirection({ dx: -0.08, dy: 0.01, zoom: 0 })).toBe("left");
    expect(flowDirection({ dx: 0.01, dy: -0.06, zoom: 0 })).toBe("up");
    expect(flowDirection({ dx: 0, dy: 0.06, zoom: 0 })).toBe("down");
  });
  it("reads a push or a pull when the zoom's edge speed leads, even with a little slide", () => {
    expect(flowDirection({ dx: 0.01, dy: 0, zoom: 0.12 })).toBe("push");
    expect(flowDirection({ dx: 0, dy: 0.01, zoom: -0.1 })).toBe("pull");
    expect(flowDirection({ dx: 0.08, dy: 0, zoom: 0.05 })).toBe("right");
  });
  it("is static under the still threshold, and a gentle gimbal push is not static", () => {
    expect(flowDirection({ dx: 0.004, dy: 0.003, zoom: 0.01 })).toBe("static");
    expect(flowDirection({ dx: 0, dy: 0, zoom: 0.03 })).toBe("push");
  });
  it("calls a turn only when it leads plainly", () => {
    expect(flowDirection({ dx: 0.005, dy: 0, zoom: 0.004, rotate: 0.1 })).toBe("rotate");
    // A slow drift with some fitted roll is still a drift.
    expect(flowDirection({ dx: 0.03, dy: 0, zoom: 0, rotate: 0.04 })).toBe("right");
  });
});

describe("bestWindows", () => {
  it("chooses the sharp, moving stretch, not the middle", () => {
    // 10 s; soft and still everywhere but 6.5–8.5 s.
    const samples = clip(10000, (t) => (t >= 6500 && t < 8500 ? { sharpness: 0.9, dx: 0.1 } : { sharpness: 0.2, dx: 0 }));
    const [best] = bestWindows(samples, 10000, 1500);
    expect(best.startMs).toBeGreaterThanOrEqual(6500);
    expect(best.endMs).toBeLessThanOrEqual(8500);
    expect(best.direction).toBe("right");
  });
  it("keeps clear of the start and end wobble and returns non-overlapping windows, best first", () => {
    const samples = clip(6000);
    const windows = bestWindows(samples, 6000, 1500, { count: 3 });
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      expect(w.startMs).toBeGreaterThanOrEqual(EDGE_GUARD_MS);
      expect(w.endMs).toBeLessThanOrEqual(6000 - EDGE_GUARD_MS);
    }
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].score).toBeLessThanOrEqual(windows[i - 1].score);
      for (let j = 0; j < i; j++) expect(windows[i].endMs <= windows[j].startMs || windows[i].startMs >= windows[j].endMs).toBe(true);
    }
  });
  it("lets one blown or soft moment spoil a window", () => {
    const samples = clip(8000, (t) => (t === 2000 ? { clipHigh: 0.4, sharpness: 0.05 } : {}));
    const [best] = bestWindows(samples, 8000, 1500);
    expect(best.startMs > 2000 || best.endMs <= 2000).toBe(true);
  });
  it("gives a clip shorter than the window all it has", () => {
    const samples = clip(1000);
    expect(bestWindows(samples, 1000, 2500)).toEqual([expect.objectContaining({ startMs: 0, endMs: 1000 })]);
  });
});

describe("motionSegments and flowPeaks", () => {
  it("merges one-sample blips and folds short runs into their neighbours", () => {
    const samples = clip(6000, (t) => (t < 3000 ? { dx: 0.08 } : { dx: -0.08 }));
    samples[5] = sample(1250, { dx: -0.08 });
    const segments = motionSegments(samples, 500, 6000);
    expect(segments.map((s) => s.direction)).toEqual(["right", "left"]);
    expect(segments[0].startMs).toBe(0);
    expect(segments[1].endMs).toBe(6000);
  });
  it("finds a cut-on-action peak", () => {
    const samples = clip(6000, (t) => (t === 3000 ? { dx: 0.5 } : { dx: 0.02 }));
    expect(flowPeaks(samples).map((p) => p.t)).toEqual([3000]);
  });
});

describe("eye trace", () => {
  const analysis = (width: number, height: number, x: number, path: ShotAnalysis["reframe"] = null): ShotAnalysis =>
    shotAnalysisSchema.parse({
      version: 1, durationMs: 4000, width, height, sampleMs: 250, aestheticEveryMs: 1000,
      samples: clip(4000, () => ({ saliency: { x, y: 0.4, strength: 0.8 } })), windows: [], motion: [], flowPeaks: [], depth: [], occluders: [],
      reframe: path, scene: { palette: [], round: null, rectilinear: 0, brightnessRamps: [], blowouts: [] },
      models: { aesthetic: null, depth: null, saliency: "test" },
    });
  it("measures in reel-frame widths, height counting 16/9 as much", () => {
    expect(eyeTraceDistance({ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.5 })).toBeCloseTo(0.1);
    expect(eyeTraceDistance({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 + 9 / 160 })).toBeCloseTo(0.1);
  });
  it("maps a landscape source's point through the centred crop", () => {
    const a = analysis(1920, 1080, 0.5);
    expect(toReelPoint(a, { x: 0.5, y: 0.4 }, 0).x).toBeCloseTo(0.5);
    // The crop is 0.316 of the width; a point at its left edge lands at reel x 0.
    const w = (9 / 16) / (16 / 9);
    expect(toReelPoint(a, { x: 0.5 - w / 2, y: 0.4 }, 0).x).toBeCloseTo(0);
  });
  it("follows the reframe crop", () => {
    const a = analysis(1920, 1080, 0.3, { aspect: 16 / 9, cropWidth: 0.3164, path: [{ t: 0, x: 0.3, y: 0.5 }, { t: 4000, x: 0.3, y: 0.5 }], closeUps: [] });
    expect(toReelPoint(a, { x: 0.3, y: 0.4 }, 1000).x).toBeCloseTo(0.5);
  });
  it("passes a cut whose attention points line up and fails one that jumps", () => {
    const left = analysis(1080, 1920, 0.3), alsoLeft = analysis(1080, 1920, 0.35), right = analysis(1080, 1920, 0.8);
    expect(cutEyeTrace(left, 3750, alsoLeft, 0)!.ok).toBe(true);
    const jump = cutEyeTrace(left, 3750, right, 0)!;
    expect(jump.ok).toBe(false);
    expect(jump.distance).toBeGreaterThan(EYE_TRACE_LIMIT);
  });
});

describe("the Reel 91 fixture", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/shot-analysis-reel91.json", import.meta.url), "utf8")) as { clips: Record<string, { fileName: string; analysis: unknown }> };
  it("parses against the contract for all eight clips, with a digest and a line each", () => {
    const clips = Object.values(fixture.clips);
    expect(clips).toHaveLength(8);
    for (const { analysis } of clips) {
      const parsed = parseShotAnalysis(analysis);
      expect(parsed).not.toBeNull();
      expect(digestShotAnalysis(parsed!).durationMs).toBeGreaterThan(0);
      expect(describeShotAnalysis(parsed!)).toMatch(/best/);
    }
  });
});
