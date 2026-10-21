import { describe, expect, it } from "vitest";
import { trackPoint, type Gray } from "../src/reel/point-track";

const W = 120, H = 120;

/** Seeded value noise at lattice point (i, j): a texture with no repeat for the tracker to alias on. */
function lattice(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** The texture shifted by (sx, sy), bilinear between lattice points 3 px apart: what a camera move does to a patch. */
function field(sx: number, sy: number, flat = false): Gray {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x - sx) / 3, v = (y - sy) / 3;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const top = lattice(i, j) * (1 - fu) + lattice(i + 1, j) * fu, bottom = lattice(i, j + 1) * (1 - fu) + lattice(i + 1, j + 1) * fu;
    data[y * W + x] = flat ? 0.5 : top * (1 - fv) + bottom * fv;
  }
  return { data, width: W, height: H };
}

describe("the point tracker (ADR 0051)", () => {
  it("finds a shifted patch to sub-pixel accuracy", () => {
    const found = trackPoint(field(0, 0), { x: 60, y: 60 }, field(7.5, -4.25), { x: 60, y: 60 });
    expect(found.status).toBe("tracked");
    expect(found.score).toBeGreaterThan(0.9);
    expect(Math.abs(found.x - 67.5)).toBeLessThan(0.3);
    expect(Math.abs(found.y - 55.75)).toBeLessThan(0.3);
  });

  it("keeps the prediction when the patch is flat, at the edge, or out of reach", () => {
    expect(trackPoint(field(0, 0, true), { x: 60, y: 60 }, field(0, 0), { x: 61, y: 62 })).toMatchObject({ x: 61, y: 62, status: "flat" });
    expect(trackPoint(field(0, 0), { x: 3, y: 60 }, field(0, 0), { x: 3, y: 60 }).status).toBe("edge");
    const far = trackPoint(field(0, 0), { x: 60, y: 60 }, field(0, 0, true), { x: 60, y: 60 });
    expect(far).toMatchObject({ x: 60, y: 60, status: "lost" });
  });
});
