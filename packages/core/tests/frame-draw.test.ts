import { describe, expect, it } from "vitest";
import { clipPicture, sourceToComposition } from "../src";
import { ANALYSIS_FILL, drawClipFrame, type DrawContext } from "../../../apps/web/components/editor/frame-draw";

/**
 * A recording 2D context that rasterises what drawClipFrame does into a small
 * grid: fills paint their colour, a drawImage paints a texture whose value
 * changes every pixel (so it has gradient everywhere it lands).
 */
function raster(width: number, height: number) {
  const px = new Float64Array(width * height).fill(NaN);
  let m = [1, 0, 0, 1, 0, 0];
  const filters: string[] = [];
  const draws: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack: number[][] = [];
  const ctx = {
    filter: "none",
    fillStyle: "#000" as DrawContext["fillStyle"],
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { m = [a, b, c, d, e, f]; },
    save() { stack.push(m); },
    restore() { m = stack.pop() ?? [1, 0, 0, 1, 0, 0]; },
    fillRect(x: number, y: number, w: number, h: number) {
      const value = this.fillStyle === ANALYSIS_FILL ? 128 : 0;
      for (let j = Math.max(0, Math.floor(y)); j < Math.min(height, y + h); j++) for (let i = Math.max(0, Math.floor(x)); i < Math.min(width, x + w); i++) px[j * width + i] = value;
    },
    drawImage(_media: unknown, _sx: number, _sy: number, _sw: number, _sh: number, dx: number, dy: number, dw: number, dh: number) {
      if (this.filter !== "none") filters.push(this.filter);
      const x0 = m[0] * dx + m[4], y0 = m[3] * dy + m[5], x1 = m[0] * (dx + dw) + m[4], y1 = m[3] * (dy + dh) + m[5];
      draws.push({ x0, y0, x1, y1 });
      for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) if (i + 0.5 >= x0 && i + 0.5 < x1 && j + 0.5 >= y0 && j + 0.5 < y1) px[j * width + i] = 1000 + i * 7 + j * 13;
    },
  };
  return { ctx: ctx as unknown as DrawContext, px, filters, draws };
}

const media = {} as CanvasImageSource;
const moment = { progress: 0.4, seconds: 1 };

describe("drawClipFrame", () => {
  it("draws a Fit frame for analysis as the picture alone on flat grey: no gradient outside the picture", () => {
    const W = 36, H = 64, source = { width: 1920, height: 1080 };
    const clip = { fit: "contain" as const, zoom: 1, motion: "none" as const };
    const r = raster(W, H);
    drawClipFrame(r.ctx, media, source, clip, moment, W, H, { kind: "analysis" });
    // One draw, of the picture, with no filter: no backdrop and no grade.
    expect(r.draws).toHaveLength(1);
    expect(r.filters).toEqual([]);
    const picture = clipPicture(clip, source, moment);
    const [u0, v0] = sourceToComposition(picture, 0, 0), [u1, v1] = sourceToComposition(picture, 1920, 1080);
    expect(r.draws[0].x0 / W).toBeCloseTo(u0, 6); expect(r.draws[0].y0 / H).toBeCloseTo(v0, 6);
    expect(r.draws[0].x1 / W).toBeCloseTo(u1, 6); expect(r.draws[0].y1 / H).toBeCloseTo(v1, 6);
    let outside = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const v = (j + 0.5) / H;
      if (v >= v0 && v < v1) continue;
      outside++;
      expect(r.px[j * W + i]).toBe(128);
      if (i + 1 < W && ((j + 0.5) / H < v0 || (j + 0.5) / H >= v1)) expect(r.px[j * W + i + 1] - r.px[j * W + i]).toBe(0);
    }
    expect(outside).toBeGreaterThan(W * H * 0.5);
  });

  it("draws the blurred backdrop and the grade only for viewing, and only where canvas filters exist", () => {
    const source = { width: 1920, height: 1080 };
    const clip = { fit: "contain" as const, zoom: 1, motion: "none" as const };
    const view = raster(36, 64);
    drawClipFrame(view.ctx, media, source, clip, moment, 36, 64, { kind: "view", grade: "saturate(1.2)", canFilter: true });
    expect(view.draws).toHaveLength(2);
    expect(view.filters[0]).toContain("blur(");
    expect(view.filters[1]).toBe("saturate(1.2)");
    const safari = raster(36, 64);
    drawClipFrame(safari.ctx, media, source, clip, moment, 36, 64, { kind: "view", grade: "saturate(1.2)", canFilter: false });
    expect(safari.draws).toHaveLength(1);
    expect(safari.filters).toEqual([]);
  });

  it("fills the frame under Fill, with zoom and move", () => {
    const r = raster(36, 64);
    drawClipFrame(r.ctx, media, { width: 1920, height: 1080 }, { fit: "cover", zoom: 1.3, motion: "pan" }, moment, 36, 64, { kind: "analysis" });
    expect(Array.from(r.px).every((v) => v >= 1000)).toBe(true);
  });
});
