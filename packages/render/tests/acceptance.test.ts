import { describe, expect, it } from "vitest";
import { parseTimeline } from "@reelwalk/core";
import { blank, compareImages, contactSheet, crop, differenceMask, maskBounds, resize, ssim, withinTolerance, worstBlockDiff, type Rgb } from "../scripts/acceptance/image";
import { judgeAttachment, measureAttachment, planeRect } from "../scripts/acceptance/attachment";
import { fiveFrames, planeFromPath } from "../scripts/acceptance/placement";
import { fiveOf } from "../scripts/compare-frames";

/** A picture with texture: a diagonal ramp plus a checker, so SSIM has structure to see. */
function textured(width: number, height: number, shift = 0): Rgb {
  const image = blank(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = ((x + shift + y) * 3) % 200 + (((x + shift) >> 3) + (y >> 3)) % 2 * 40;
    image.data.set([v, 255 - v, (v * 7) % 256], (y * width + x) * 3);
  }
  return image;
}

/** Paints a filled rectangle. */
function paint(image: Rgb, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): Rgb {
  const out = { ...image, data: image.data.slice() };
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.data.set(rgb, (y * image.width + x) * 3);
  return out;
}

describe("acceptance image measures", () => {
  it("scores a picture against itself as identical", () => {
    const a = textured(64, 96);
    expect(ssim(a, a)).toBeCloseTo(1, 6);
    expect(worstBlockDiff(a, a).diff).toBe(0);
    expect(withinTolerance(compareImages(a, a), { minSsim: 0.99, maxBlock: 1 })).toBe(true);
  });

  it("forgives a little noise but not a moved picture", () => {
    const a = textured(64, 96);
    const noisy = { ...a, data: a.data.map((v, i) => Math.max(0, Math.min(255, v + ((i * 7919) % 7) - 3))) };
    const moved = textured(64, 96, 9);
    expect(ssim(a, noisy)).toBeGreaterThan(0.95);
    expect(ssim(a, moved)).toBeLessThan(0.8);
  });

  it("finds a small title the mean similarity would average away", () => {
    const a = textured(128, 192);
    const titled = paint(a, 40, 40, 72, 56, [255, 255, 255]);
    expect(ssim(a, titled)).toBeGreaterThan(0.9);
    const worst = worstBlockDiff(a, titled);
    expect(worst.diff).toBeGreaterThan(40);
    expect(worst.x).toBeGreaterThanOrEqual(32);
    expect(worst.x).toBeLessThan(80);
  });

  it("crops, resizes and lays out a contact sheet", () => {
    const a = textured(40, 80);
    expect(crop(a, 10, 10, 20, 30)).toMatchObject({ width: 20, height: 30 });
    expect(crop(a, 30, 70, 50, 50)).toMatchObject({ width: 10, height: 10 });
    const flat = paint(blank(8, 8), 0, 0, 8, 8, [100, 50, 200]);
    expect(Array.from(resize(flat, 2, 2).data.slice(0, 3))).toEqual([100, 50, 200]);
    const sheet = contactSheet([[a, a, a], [a]], 20, 2);
    expect(sheet.width).toBe(2 + 3 * 22);
    expect(sheet.height).toBe(2 + 2 * (40 + 2));
  });

  it("masks what one picture adds to the other", () => {
    const a = textured(64, 64);
    const mask = differenceMask(a, paint(a, 10, 20, 30, 25, [255, 255, 255]));
    expect(maskBounds(mask, 64)).toMatchObject({ left: 10, top: 20, right: 29, bottom: 24 });
    expect(maskBounds(new Uint8Array(16), 4)).toBeNull();
  });

  it("takes the first, quarter, half, three-quarter and last frame of a shot", () => {
    expect(fiveOf(0, 75)).toEqual([0, 19, 37, 56, 74]);
    expect(fiveOf(10, 12)).toEqual([10, 11]);
  });
});

describe("acceptance attachment", () => {
  const W = 200, H = 200;
  /** A glyph block: the pixels of the plane's rectangle between u0..u1, v0..v1, drawn through the plane's corners. */
  function glyphs(quad: number[], u: [number, number], v: [number, number]): Uint8Array {
    const mask = new Uint8Array(W * H);
    const rect = planeRect(quad, W, H);
    // An axis-aligned plane keeps this simple: the rectangle is the quad.
    const x0 = quad[0] * W, y0 = quad[1] * H;
    for (let y = Math.round(y0 + v[0] * rect.height); y < Math.round(y0 + v[1] * rect.height); y++)
      for (let x = Math.round(x0 + u[0] * rect.width); x < Math.round(x0 + u[1] * rect.width); x++) mask[y * W + x] = 1;
    return mask;
  }
  const plane = [0.2, 0.2, 0.8, 0.2, 0.8, 0.5, 0.2, 0.5];
  const moved = plane.map((v, i) => v + (i % 2 === 0 ? 0.1 : 0.05));
  const flags = { expectVisible: true, fullStrength: true, clipped: true };

  it("passes a title that moves with its plane", () => {
    const frames = [
      { ...measureAttachment({ frame: 0, mask: glyphs(plane, [0.05, 0.95], [0.1, 0.9]), width: W, height: H, quad: plane, base: plane, clipped: true, tolerancePx: 2 }), ...flags },
      { ...measureAttachment({ frame: 1, mask: glyphs(moved, [0.05, 0.95], [0.1, 0.9]), width: W, height: H, quad: moved, base: plane, clipped: true, tolerancePx: 2 }), ...flags },
    ];
    const verdict = judgeAttachment(frames, 2);
    expect(verdict.problems).toEqual([]);
    expect(verdict.drift).toBeLessThan(1.5);
  });

  it("fails a title that stays put while its plane moves (walks off it)", () => {
    const frames = [
      { ...measureAttachment({ frame: 0, mask: glyphs(plane, [0.05, 0.95], [0.1, 0.9]), width: W, height: H, quad: plane, base: plane, clipped: true, tolerancePx: 2 }), ...flags },
      { ...measureAttachment({ frame: 1, mask: glyphs(plane, [0.05, 0.95], [0.1, 0.9]), width: W, height: H, quad: moved, base: plane, clipped: true, tolerancePx: 2 }), ...flags },
    ];
    const verdict = judgeAttachment(frames, 2);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/off the plane/);
    expect(verdict.problems.join(" ")).toMatch(/moves/);
  });

  it("lets an unclipped title overflow sideways but not off centre or above its plane", () => {
    const wide = { ...measureAttachment({ frame: 0, mask: glyphs(plane, [-0.1, 1.1], [0.2, 0.8]), width: W, height: H, quad: plane, base: plane, clipped: false, tolerancePx: 2 }), expectVisible: true, fullStrength: true, clipped: false };
    expect(judgeAttachment([wide], 2).problems).toEqual([]);
    const offCentre = { ...measureAttachment({ frame: 0, mask: glyphs(plane, [0.3, 1.1], [0.2, 0.8]), width: W, height: H, quad: plane, base: plane, clipped: false, tolerancePx: 2 }), expectVisible: true, fullStrength: true, clipped: false };
    expect(judgeAttachment([offCentre], 2).problems.join(" ")).toMatch(/centred/);
    const high = { ...measureAttachment({ frame: 0, mask: glyphs(plane, [0.1, 0.9], [-0.4, 0.5]), width: W, height: H, quad: plane, base: plane, clipped: false, tolerancePx: 2 }), expectVisible: true, fullStrength: true, clipped: false };
    expect(judgeAttachment([high], 2).problems.join(" ")).toMatch(/off the plane/);
  });

  it("reports a visible title that drew nothing, and allows a faded one to", () => {
    const empty = measureAttachment({ frame: 3, mask: new Uint8Array(W * H), width: W, height: H, quad: plane, base: plane, clipped: true, tolerancePx: 2 });
    expect(judgeAttachment([{ ...empty, ...flags }], 2).problems.join(" ")).toMatch(/drew no pixels/);
    expect(judgeAttachment([{ ...empty, ...flags, expectVisible: false, fullStrength: false }], 2).ok).toBe(true);
  });
});

describe("acceptance placement", () => {
  const quad = [0.3, 0.3, 0.7, 0.3, 0.7, 0.45, 0.3, 0.45];
  const later = [0.32, 0.31, 0.72, 0.31, 0.72, 0.46, 0.32, 0.46];
  const timeline = parseTimeline({ version: 1, music: null, clips: [
    { id: "a", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1000 },
    { id: "b", assetId: "y", kind: "VIDEO", sourceStartMs: 500, sourceEndMs: 1500 },
  ], texts: [
    { id: "p", text: "ON THE WALL", startMs: 900, endMs: 2000, x: 0.5, y: 0.4, style: "headline", animation: "none", blend: "surface", surface: quad,
      pin: { assetId: "y", fromMs: 500, toMs: 1500, quad }, path: [{ t: 0, x: 0, y: 0, q: quad }, { t: 1, x: 0, y: 0, q: later, o: 0.5 }] },
    { id: "s", text: "BARE", startMs: 0, endMs: 1000, x: 0.5, y: 0.4, style: "headline", surface: quad },
    { id: "t", text: "flat", startMs: 0, endMs: 1000, x: 0.5, y: 0.4, style: "headline" },
  ] });
  const [pinned, bare, flat] = timeline.texts;

  it("follows a pinned title's keyframes over its own shot only", () => {
    expect(planeFromPath(timeline, pinned, 27, 30)).toBeNull(); // still on the first shot
    expect(planeFromPath(timeline, pinned, 30, 30)).toMatchObject({ quad, base: quad, opacity: 1, clipped: true });
    const end = planeFromPath(timeline, pinned, 59, 30)!;
    end.quad.forEach((v, i) => expect(v).toBeCloseTo(quad[i] + (later[i] - quad[i]) * (29 / 30), 6));
    expect(end.opacity).toBeCloseTo(1 - 0.5 * (29 / 30), 6);
  });

  it("places a surface without a pin where it was set, and gives a flat title no plane", () => {
    expect(planeFromPath(timeline, bare, 10, 30)).toMatchObject({ quad, base: quad });
    expect(planeFromPath(timeline, flat, 10, 30)).toBeNull();
  });

  it("chooses five frames of the title's life on its plane", () => {
    expect(fiveFrames(timeline, pinned, 30)).toEqual([30, 37, 45, 52, 59]);
  });
});
