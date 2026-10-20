import { describe, expect, it } from "vitest";
import { findSurfaceQuad, houghLines, type Gray } from "../src";

/** A frame with a bright trapezoid (a wall panel seen at an angle) over a dim gradient. */
function panel(width: number, height: number, quad: number[]): Gray {
  const data = new Float32Array(width * height);
  const inside = (x: number, y: number) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const ax = quad[i * 2], ay = quad[i * 2 + 1], bx = quad[((i + 1) % 4) * 2], by = quad[((i + 1) % 4) * 2 + 1];
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (cross === 0) continue;
      if (sign === 0) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = (inside(x, y) ? 200 : 60) + (x + y) * 0.02;
  return { data, width, height };
}

describe("finding the flat surface under a title", () => {
  it("recovers a slanted panel's corners from its edges", () => {
    const quad = [80, 150, 300, 110, 300, 420, 80, 380];
    const gray = panel(360, 640, quad);
    const found = findSurfaceQuad(gray, 190, 265)!;
    expect(found).not.toBeNull();
    for (let i = 0; i < 8; i++) expect(Math.abs(found.quad[i] - quad[i])).toBeLessThan(8);
    expect(Math.min(found.sides.left, found.sides.right, found.sides.top, found.sides.bottom)).toBeGreaterThan(20);
  });
  it("uses the frame edge for a side with no edge, and follows slanted families", () => {
    // A panel whose left side runs off the frame: the left corners sit at the search window's edge.
    const quad = [-40, 150, 300, 110, 300, 420, -40, 380];
    const found = findSurfaceQuad(panel(360, 640, quad), 150, 265)!;
    expect(found).not.toBeNull();
    expect(found.sides.left).toBe(0);
    expect(Math.abs(found.quad[2] - 300)).toBeLessThan(8); expect(Math.abs(found.quad[4] - 300)).toBeLessThan(8);
  });

  it("gives up on a blank wall and finds straight lines in general", () => {
    const blank: Gray = { data: new Float32Array(360 * 640).fill(120), width: 360, height: 640 };
    expect(findSurfaceQuad(blank, 180, 320)).toBeNull();
    const pts = Array.from({ length: 200 }, (_, i) => ({ x: 50 + i, y: 100, dir: Math.PI / 2 }));
    const lines = houghLines(pts, 360, 640, { minVotes: 50 });
    expect(lines.length).toBeGreaterThan(0);
    expect(Math.abs(lines[0].theta - Math.PI / 2)).toBeLessThan(0.05);
    expect(Math.abs(lines[0].rho - 100)).toBeLessThan(2);
  });
});

describe("houghLines keeps symmetric edges", () => {
  it("returns both of two parallel edges at equal distance either side of the centre", () => {
    const pts: { x: number; y: number; dir: number }[] = [];
    for (let y = 0; y < 200; y++) { pts.push({ x: 50, y, dir: 0 }); pts.push({ x: 150, y, dir: 0 }); }
    const lines = houghLines(pts, 200, 200, { minVotes: 150 });
    const rhos = lines.filter((l) => Math.abs(l.theta) < 0.01 || Math.abs(l.theta - Math.PI) < 0.01).map((l) => Math.round(Math.abs(l.rho))).sort((a, b) => a - b);
    expect(rhos).toEqual([50, 150]);
  });
});
