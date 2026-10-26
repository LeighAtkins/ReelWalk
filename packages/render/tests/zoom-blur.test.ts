import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cutBlurFilter } from "../src/reel/motion-cut-blur";
import { encodePng, roundFocus, zoomBlurCopies, zoomBlurMeanScale, zoomBlurStageCount, zoomBlurStages, zoomFilterSpec, zoomMapPixels, zoomMapRamps, zoomStageId } from "../src/reel/zoom-blur";

/**
 * The zoom blur (ADR 0074, brought back for ADR 0089's motion cut on a push or pull): the plan of its filter and the
 * displacement map it reads.
 */
describe("the stack of copies", () => {
  it("doubles: S stages make 2^S copies spanning 0 to the spread in equal steps, the sharp one first", () => {
    for (const spread of [0.02, 0.05, 0.12, 0.2]) {
      const copies = zoomBlurCopies(spread);
      expect(copies).toHaveLength(2 ** zoomBlurStageCount(spread));
      expect(copies[0]).toBe(0);
      expect(copies.at(-1)).toBeCloseTo(spread, 12);
      const step = copies[1] - copies[0];
      copies.forEach((k, i) => expect(k).toBeCloseTo(i * step, 12));
    }
  });

  it("takes more stages for a stronger blur, from one to three, so a faint blur costs a faint amount", () => {
    expect([0.005, 0.03, 0.031, 0.08, 0.081, 0.2].map(zoomBlurStageCount)).toEqual([1, 1, 2, 2, 3, 3]);
    // The stages' magnifications add up to the spread, each double the one before, and each averages half and half.
    const stages = zoomBlurStages(0.14);
    expect(stages.reduce((sum, stage) => sum + stage.k, 0)).toBeCloseTo(0.14, 12);
    expect(stages[1].k / stages[0].k).toBeCloseTo(2, 12);
    expect(stages.every((stage) => stage.mix === 0.5)).toBe(true);
  });

  it("sits the average larger than the sharp frame by half the spread, in the direction of the push, never smaller", () => {
    for (const spread of [0.01, 0.06, 0.15]) {
      expect(zoomBlurMeanScale(spread)).toBeCloseTo(spread / 2, 12);
      expect(Math.min(...zoomBlurCopies(spread))).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the displacement map", () => {
  it("reads 0.5 on both channels at the focus, rising to the right and downward, and fits 0..1 for any focus", () => {
    for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.8], [0.8, 0.2], [0.35, 0.55]]) {
      const map = zoomMapRamps(fx, fy);
      expect(map.x[0] + (map.x[1] - map.x[0]) * fx).toBeCloseTo(0.5, 12);
      expect(map.y[0] + (map.y[1] - map.y[0]) * fy).toBeCloseTo(0.5, 12);
      for (const value of [...map.x, ...map.y]) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
      expect(map.x[1]).toBeGreaterThan(map.x[0]);
      expect(map.y[1]).toBeGreaterThan(map.y[0]);
      // Equal slope on both axes (1/range of a pixel), so a displacement scale of -k·range magnifies uniformly by 1 + k.
      expect(map.x[1] - map.x[0]).toBeCloseTo(1080 / map.range, 9);
      expect(map.y[1] - map.y[0]).toBeCloseTo(1920 / map.range, 9);
    }
  });

  it("has a range of the frame height for the middle, the farthest corner otherwise", () => {
    expect(zoomMapRamps(0.5, 0.5).range).toBe(1920);
    expect(zoomMapRamps(0.2, 0.5).range).toBe(1920);
    expect(zoomMapRamps(0.5, 0.2).range).toBeCloseTo(2 * 0.8 * 1920, 9);
  });

  it("is a real PNG: its signature, its chunks' checks and a pixel array that is the ramp", () => {
    const rgb = zoomMapPixels(zoomMapRamps(0.5, 0.5));
    const png = encodePng(54, 96, rgb);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const chunks: { type: string; data: Uint8Array }[] = [];
    for (let at = 8; at < png.length;) {
      const length = view.getUint32(at);
      chunks.push({ type: String.fromCharCode(...png.subarray(at + 4, at + 8)), data: png.subarray(at + 8, at + 8 + length) });
      at += 12 + length;
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([54, 96]);
    // The zlib stream inflates to filter byte 0 and the pixels of each row.
    const raw = inflateSync(chunks[1].data);
    expect(raw.length).toBe((54 * 3 + 1) * 96);
    for (let y = 0; y < 96; y++) {
      expect(raw[y * 163]).toBe(0);
      expect(Array.from(raw.subarray(y * 163 + 1, (y + 1) * 163))).toEqual(Array.from(rgb.subarray(y * 162, (y + 1) * 162)));
    }
    // Red climbs across, green down, blue unused.
    expect(rgb[0]).toBeLessThan(rgb[53 * 3]);
    expect(rgb[1]).toBeLessThan(rgb[95 * 54 * 3 + 1]);
    expect(rgb.every((value, i) => i % 3 !== 2 || value === 0)).toBe(true);
  });

  it("rounds the focus to a hundredth within the middle three fifths, so the map repeats frame to frame", () => {
    expect(roundFocus(0.3333)).toBe(0.33);
    expect(roundFocus(0.04)).toBe(0.2);
    expect(roundFocus(0.97)).toBe(0.8);
    expect(zoomFilterSpec(0.1, 0.331, 0.5).map).toBe(zoomFilterSpec(0.07, 0.334, 0.5).map);
    expect(zoomFilterSpec(0.1, 0.5, 0.5).map).not.toBe(zoomFilterSpec(0.1, 0.4, 0.5).map);
  });
});

describe("the filter's plan", () => {
  it("has one stage per doubling, each displacing by minus its magnification times the map's range and averaging half and half", () => {
    const spec = zoomFilterSpec(0.14, 0.5, 0.5);
    const range = zoomMapRamps(0.5, 0.5).range;
    expect(spec.stages).toHaveLength(3);
    spec.stages.forEach((stage, s) => {
      expect(stage.scale).toBeCloseTo(-((0.14 * 2 ** s) / 7) * range, 9);
      expect(stage.keep + stage.add).toBe(1);
    });
    expect(spec.map.startsWith("data:image/png;base64,")).toBe(true);
    expect(spec.stages.every((stage) => stage.scale < 0)).toBe(true);
  });

  it("is chained in the CSS filter, one reference per stage, and one reference for an axis blur (ADR 0089's motion cut)", () => {
    expect(cutBlurFilter({ kind: "axis", sx: 4, sy: 0 }, "mcut-c1")).toBe("url(#mcut-c1)");
    expect(cutBlurFilter({ kind: "zoom", spread: 0.1 }, "mcut-c1")).toBe(`url(#${zoomStageId("mcut-c1", 0)}) url(#${zoomStageId("mcut-c1", 1)}) url(#${zoomStageId("mcut-c1", 2)})`);
    expect(cutBlurFilter({ kind: "zoom", spread: 0.02 }, "mcut-c1")).toBe(`url(#${zoomStageId("mcut-c1", 0)})`);
    expect(cutBlurFilter({ kind: "none" }, "mcut-c1")).toBeUndefined();
  });
});
