import { describe, expect, it } from "vitest";
import { applyCommand, type CommandContext } from "../src/commands";
import {
  applyColorMatch,
  applyColorMatchToRgba,
  colorMatrixValues,
  colorStatsFromRgba,
  GAIN_MAX,
  IDENTITY_MATCH,
  isIdentityMatch,
  lookDistance,
  lookSampleMs,
  matchLook,
  matchTransform,
  mergeColorStats,
  type ColorStats,
} from "../src/look";
import { parseTimeline, type Timeline } from "../src/timeline";

// One coherent look (ADR 0070): the transform moves a clip's colour statistics onto the reference's.

/** A synthetic frame: a smooth gradient with a cast, so it has spread in every channel. */
function frame(width: number, height: number, tint: { r: number; g: number; b: number }, spread = 0.5): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const t = (x / (width - 1)) * spread + (y / (height - 1)) * spread * 0.5;
      data[i] = Math.round(255 * Math.min(1, Math.max(0, tint.r + t * 0.6 - spread * 0.4)));
      data[i + 1] = Math.round(255 * Math.min(1, Math.max(0, tint.g + t * 0.5 - spread * 0.3)));
      data[i + 2] = Math.round(255 * Math.min(1, Math.max(0, tint.b + t * 0.4 - spread * 0.2)));
      data[i + 3] = 255;
    }
  }
  return data;
}

const W = 64, H = 112;
// Three creators' houses: a warm dark one, a cool bright one, a flat green-ish one.
const warm = frame(W, H, { r: 0.55, g: 0.4, b: 0.25 });
const cool = frame(W, H, { r: 0.45, g: 0.55, b: 0.7 }, 0.4);
const green = frame(W, H, { r: 0.4, g: 0.5, b: 0.4 }, 0.3);

const stats = (data: Uint8ClampedArray) => colorStatsFromRgba(data, W, H);

describe("colour statistics", () => {
  it("measures a cast and an exposure", () => {
    const a = stats(warm), b = stats(cool);
    // Warm: V (red−luma) positive; cool: U (blue−luma) positive and brighter.
    expect(a.mean[2]).toBeGreaterThan(0);
    expect(b.mean[1]).toBeGreaterThan(0);
    expect(b.mean[0]).toBeGreaterThan(a.mean[0]);
    expect(a.std.every((value) => value > 0)).toBe(true);
  });

  it("skips transparent pixels and reads every n-th pixel", () => {
    const data = frame(W, H, { r: 0.5, g: 0.5, b: 0.5 });
    const full = colorStatsFromRgba(data, W, H);
    const sampled = colorStatsFromRgba(data, W, H, 3);
    expect(Math.abs(full.mean[0] - sampled.mean[0])).toBeLessThan(0.01);
    const masked = new Uint8ClampedArray(data);
    for (let i = 3; i < masked.length; i += 4) masked[i] = 0;
    expect(colorStatsFromRgba(masked, W, H)).toEqual({ mean: [0, 0, 0], std: [0, 0, 0] });
  });

  it("pools frames of one clip", () => {
    const a: ColorStats = { mean: [0.4, 0, 0], std: [0.1, 0.05, 0.05] };
    const b: ColorStats = { mean: [0.6, 0, 0], std: [0.1, 0.05, 0.05] };
    const pooled = mergeColorStats([a, b])!;
    expect(pooled.mean[0]).toBeCloseTo(0.5, 4);
    // Pooled spread includes the difference between the frames' means.
    expect(pooled.std[0]).toBeCloseTo(Math.sqrt(0.01 + 0.01), 3);
    expect(mergeColorStats([])).toBeNull();
  });
});

describe("matchTransform", () => {
  it("moves the source's means and spread onto the reference within tolerance", () => {
    for (const [source, reference] of [[warm, cool], [cool, warm], [green, warm], [green, cool]] as const) {
      const s = stats(source), r = stats(reference);
      const match = matchTransform(s, r);
      const out = new Uint8ClampedArray(source);
      applyColorMatchToRgba(match, out);
      const after = stats(out);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(after.mean[c] - r.mean[c])).toBeLessThan(0.012);
        expect(Math.abs(after.std[c] - r.std[c])).toBeLessThan(Math.max(0.012, r.std[c] * 0.15));
      }
      expect(lookDistance(after, r)).toBeLessThan(0.012);
      expect(lookDistance(s, r)).toBeGreaterThan(0.03);
    }
  });

  it("is the identity at strength 0 and halfway at 0.5", () => {
    const s = stats(warm), r = stats(cool);
    expect(matchTransform(s, r, 0)).toEqual(IDENTITY_MATCH);
    const half = new Uint8ClampedArray(warm);
    applyColorMatchToRgba(matchTransform(s, r, 0.5), half);
    const after = stats(half);
    for (let c = 0; c < 3; c++) expect(Math.abs(after.mean[c] - (s.mean[c] + r.mean[c]) / 2)).toBeLessThan(0.012);
  });

  it("clamps the gain on a flat source instead of amplifying noise", () => {
    const flat: ColorStats = { mean: [0.5, 0, 0], std: [0.001, 0.0005, 0.0005] };
    const match = matchTransform(flat, stats(cool));
    expect(match.m.every(Number.isFinite) && match.o.every(Number.isFinite)).toBe(true);
    // Y gain is at most GAIN_MAX: a mid grey moves by at most GAIN_MAX × its distance from the mean.
    const [r] = applyColorMatch(match, [0.5 + 0.1, 0.5 + 0.1, 0.5 + 0.1]);
    const [r0] = applyColorMatch(match, [0.5, 0.5, 0.5]);
    expect(r - r0).toBeLessThanOrEqual(0.1 * GAIN_MAX + 0.01);
  });

  it("writes an feColorMatrix", () => {
    expect(colorMatrixValues(IDENTITY_MATCH)).toBe("1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0");
    const values = colorMatrixValues(matchTransform(stats(warm), stats(cool)));
    expect(values.split(" ")).toHaveLength(20);
    expect(isIdentityMatch(matchTransform(stats(warm), stats(warm)))).toBe(true);
  });
});

describe("matchLook command", () => {
  const ctx: CommandContext = { generation: 0 };
  const reel = (): Timeline => parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, filter: "warm" },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 },
      { id: "c", assetId: "v3", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 },
    ],
    texts: [], music: null,
  });
  const measured = { a: stats(warm), b: stats(cool), c: stats(green) };

  it("matches every measured clip to the reference and keeps the preset grades", () => {
    const result = applyCommand(reel(), { type: "matchLook", referenceClipId: "a", stats: measured }, ctx);
    expect(result.rejected).toBeUndefined();
    const { timeline } = result;
    expect(timeline.look).toEqual({ referenceClipId: "a", strength: 1 });
    expect(timeline.clips[0].colorMatch).toBeUndefined();
    expect(timeline.clips[0].filter).toBe("warm");
    expect(timeline.clips[1].colorMatch).toBeDefined();
    expect(timeline.clips[2].colorMatch).toBeDefined();
    expect(timeline.clips.every((clip) => clip.colorStats)).toBe(true);
    expect(result.changes).toEqual(expect.arrayContaining([{ kind: "clip", id: "b" }, { kind: "other", key: "look" }]));
    // Round trip through the schema: a saved reel keeps its look.
    expect(parseTimeline(JSON.parse(JSON.stringify(timeline)))).toEqual(timeline);
  });

  it("re-runs on a strength change without new statistics, and clears", () => {
    const first = applyCommand(reel(), { type: "matchLook", referenceClipId: "a", stats: measured }, ctx).timeline;
    const half = applyCommand(first, { type: "matchLook", strength: 0.5 }, ctx);
    expect(half.timeline.look).toEqual({ referenceClipId: "a", strength: 0.5 });
    const full = first.clips[1].colorMatch!, part = half.timeline.clips[1].colorMatch!;
    expect(Math.abs(part.o[0])).toBeLessThan(Math.abs(full.o[0]) + 1e-9);
    expect(part.o[0]).toBeCloseTo(full.o[0] / 2, 3);
    const cleared = applyCommand(half.timeline, { type: "matchLook", referenceClipId: null }, ctx).timeline;
    expect(cleared.look).toBeUndefined();
    expect(cleared.clips.every((clip) => clip.colorMatch === undefined)).toBe(true);
    // The measurements stay, so matching again needs no pixels.
    expect(cleared.clips.every((clip) => clip.colorStats)).toBe(true);
  });

  it("changes the reference without measuring again", () => {
    const first = matchLook(reel(), { referenceClipId: "a", stats: measured });
    const second = matchLook(first, { referenceClipId: "b" });
    expect(second.clips[1].colorMatch).toBeUndefined();
    expect(second.clips[0].colorMatch).toBeDefined();
  });

  it("rejects an unknown or unmeasured reference and leaves the reel as it was", () => {
    const base = reel();
    expect(applyCommand(base, { type: "matchLook", referenceClipId: "zz", stats: measured }, ctx).rejected).toMatch(/no clip/);
    expect(applyCommand(base, { type: "matchLook", referenceClipId: "a" }, ctx).rejected).toMatch(/not been measured/);
    expect(applyCommand(base, { type: "matchLook", referenceClipId: "a" }, ctx).timeline).toBe(base);
  });

  it("leaves a clip without statistics alone", () => {
    const { timeline } = applyCommand(reel(), { type: "matchLook", referenceClipId: "a", stats: { a: measured.a, b: measured.b } }, ctx);
    expect(timeline.clips[2].colorMatch).toBeUndefined();
    expect(timeline.clips[2].colorStats).toBeUndefined();
  });
});

describe("sample points", () => {
  it("reads a video at three points inside its window, clear of its first and last frames, and a photo once", () => {
    expect(lookSampleMs({ kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 3000 })).toEqual([1300, 2000, 2700]);
    expect(lookSampleMs({ kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 })).toEqual([0]);
  });
});
