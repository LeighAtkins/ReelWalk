import { describe, expect, it } from "vitest";
import { blank, growMask, regionChange } from "../scripts/acceptance/image";
import { erode, judgeAttachment, judgeShape, measureAttachment, mirroredCorners, orientation, rectifyMask, strokeWidth } from "../scripts/acceptance/attachment";

const W = 240, H = 240;
/** An axis-aligned plane, so the plane's rectangle is the quad itself (24..216 × 72..168 px). */
const plane = [0.1, 0.3, 0.9, 0.3, 0.9, 0.7, 0.1, 0.7];

/** Letter-like strokes with a left/right and top/bottom asymmetry ("F" then "L"), 8 px thick, shifted by dx px. */
function letters(dx = 0, thickness = 8): Uint8Array {
  const mask = new Uint8Array(W * H);
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0 + dx; x < x1 + dx; x++) mask[y * W + x] = 1;
  };
  // F: a stem and two arms, the upper one longer.
  fill(40, 90, 40 + thickness, 150); fill(40, 90, 100, 90 + thickness); fill(40, 115, 80, 115 + thickness);
  // L: a stem and a foot.
  fill(130, 90, 130 + thickness, 150); fill(130, 150 - thickness, 190, 150);
  return mask;
}

const frame = (mask: Uint8Array, quad = plane, n = 0) => ({ frame: n, rectified: rectifyMask({ mask, width: W, height: H, quad, base: plane, clipped: true }), fullStrength: true, glyphs: mask.reduce((a, b) => a + b, 0) });
const flags = { expectVisible: true, fullStrength: true, clipped: true };

describe("attachment drift", () => {
  it("counts the whole travel, so 0, 2, 4, 6, 8 px is 8 px and fails a 4 px limit", () => {
    const frames = [0, 2, 4, 6, 8].map((dx, i) => ({ ...measureAttachment({ frame: i, mask: letters(dx), width: W, height: H, quad: plane, base: plane, clipped: true, tolerancePx: 4 }), ...flags }));
    const verdict = judgeAttachment(frames, 4);
    expect(verdict.drift).toBeCloseTo(8, 0);
    expect(verdict.ok).toBe(false);
  });

  it("passes travel within the limit", () => {
    const frames = [0, 1, 2, 3, 4].map((dx, i) => ({ ...measureAttachment({ frame: i, mask: letters(dx), width: W, height: H, quad: plane, base: plane, clipped: true, tolerancePx: 4 }), ...flags }));
    expect(judgeAttachment(frames, 4).ok).toBe(true);
  });
});

describe("letter shape on the plane", () => {
  const reference = frame(letters()).rectified;

  it("passes the same letters on every frame", () => {
    const verdict = judgeShape([frame(letters(), plane, 0), frame(letters(1), plane, 1)], reference, true);
    expect(verdict.problems).toEqual([]);
  });

  it("fails a title drawn through mirrored corners, though its box is the same", () => {
    const mirrored = [frame(letters(), mirroredCorners(plane), 0), frame(letters(), mirroredCorners(plane), 1)];
    // The bounding-box attachment check alone cannot see it.
    const boxes = mirrored.map((f, i) => ({ ...measureAttachment({ frame: i, mask: letters(), width: W, height: H, quad: mirroredCorners(plane), base: plane, clipped: true, tolerancePx: 4 }), ...flags }));
    expect(judgeAttachment(boxes, 4).ok).toBe(true);
    const verdict = judgeShape(mirrored, reference, false);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/mirrored/);
    const o = orientation(mirrored[0].rectified, reference);
    expect(o.acrossMirrored).toBeGreaterThan(o.across);
  });

  it("fails letters a pixel thinner all round on every frame", () => {
    expect(strokeWidth(reference)).toBeGreaterThan(6);
    const thin = erode(letters(), W, H);
    const verdict = judgeShape([frame(thin, plane, 0), frame(thin, plane, 1)], reference, false);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/strokes/);
  });

  it("fails letters that change shape mid-shot, and a missing reference", () => {
    const changed = judgeShape([frame(letters(), plane, 0), frame(letters(0, 3), plane, 1)], reference, false);
    expect(changed.problems.join(" ")).toMatch(/strokes|change shape/);
    expect(judgeShape([frame(letters())], null, false).problems.join(" ")).toMatch(/no approved reference/);
    expect(judgeShape([{ ...frame(letters()), fullStrength: false }], reference, false).problems.join(" ")).toMatch(/full strength/);
  });
});

describe("title region in the export", () => {
  it("sees a missing title over its letters that a whole-frame score would average away", () => {
    const background = blank(W, H, 200);
    const titled = { ...background, data: background.data.slice() };
    const mask = letters();
    mask.forEach((v, i) => { if (v) titled.data.fill(255, i * 3, i * 3 + 3); });
    // The title on a pale picture: its letters are 255 against 200, a 55 step.
    const inner = erode(mask, W, H);
    expect(regionChange(titled, titled, inner)).toBe(0);
    expect(regionChange(titled, background, inner)).toBe(1);
    // Grown by a pixel the region takes in background too, so the fraction falls but stays large.
    const grown = regionChange(titled, background, growMask(mask, W, H, 1));
    expect(grown).toBeGreaterThan(0.5);
    expect(grown).toBeLessThan(1);
  });
});
