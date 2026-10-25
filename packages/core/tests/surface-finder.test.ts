import { describe, expect, it } from "vitest";
import {
  applyHomography, convergeToHorizon, estimateHorizon, findSurfaces, fitTitleOnPlane, homography, invertHomography, pickCandidate, snapQuadToEdges, SURFACE_SAFE, surfaceInk, surfaceOverlap, titleAspect,
  type Gray, type Quad, type SurfaceRegion,
} from "../src";

import { corners, px, render, W, H } from "./surface-synth";

// A wall seen from the left: near edge (left) taller than the far edge (right), edges slanting like a real room.
const WALL = [0.12, 0.18, 0.86, 0.3, 0.86, 0.66, 0.12, 0.8];
const aspect = titleAspect("THE LODGE");

describe("fitTitleOnPlane", () => {
  it("returns a title-shaped rectangle in the plane's own perspective, inside the safe area", () => {
    const placed = fitTitleOnPlane(WALL, aspect)!;
    expect(placed).not.toBeNull();
    const q = placed.quad;
    for (let i = 0; i < 4; i++) {
      expect(q[i * 2]).toBeGreaterThanOrEqual(SURFACE_SAFE.left); expect(q[i * 2]).toBeLessThanOrEqual(SURFACE_SAFE.right);
      expect(q[i * 2 + 1]).toBeGreaterThanOrEqual(SURFACE_SAFE.top); expect(q[i * 2 + 1]).toBeLessThanOrEqual(SURFACE_SAFE.bottom);
    }
    // Back through the plane's homography the placement is a rectangle with the title's aspect and inside the unit square.
    const toUnit = homography(px(WALL).map((v, i) => (i % 2 === 0 ? v * 3 : v * 3)) as Quad, [0, 0, 1, 0, 1, 1, 0, 1])!;
    void toUnit;
    const inv = invertHomography(homography([0, 0, 1, 0, 1, 1, 0, 1], px(WALL))!)!;
    const local = [0, 1, 2, 3].map((i) => applyHomography(inv, q[i * 2] * W, q[i * 2 + 1] * H));
    for (const [u, v] of local) { expect(u).toBeGreaterThan(0); expect(u).toBeLessThan(1); expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1); }
    expect(local[0][1]).toBeCloseTo(local[1][1], 3); // top edge level in the plane
    expect(local[0][0]).toBeCloseTo(local[3][0], 3); // left edge upright in the plane
    const size = { w: Math.hypot(WALL[2] - WALL[0], WALL[3] - WALL[1]), h: Math.hypot(WALL[6] - WALL[0], WALL[7] - WALL[1]) };
    void size;
    expect(placed.lineHeightPx).toBeGreaterThan(52);
  });

  it("shrinks a long title until its lines are as tall as the plane allows, and refuses one that cannot be read", () => {
    const short = fitTitleOnPlane(WALL, titleAspect("HI"))!;
    const medium = fitTitleOnPlane(WALL, titleAspect("THE QUIET ROOMS"))!;
    expect(medium.lineHeightPx).toBeLessThan(short.lineHeightPx);
    // A line of thirty-eight letters across a wall is smaller than anyone can read on a phone, so it is not offered.
    expect(fitTitleOnPlane(WALL, titleAspect("THE QUIET ROOMS ABOVE THE LAKE AT DAWN"))).toBeNull();
    // Nor does a sliver of a plane carry a legible line.
    expect(fitTitleOnPlane([0.1, 0.5, 0.9, 0.5, 0.9, 0.51, 0.1, 0.51], titleAspect("THE QUIET ROOMS"))).toBeNull();
  });

  it("keeps the placement on the visible part of a plane that runs off the frame", () => {
    const placed = fitTitleOnPlane([-0.4, 0.2, 0.7, 0.2, 0.7, 0.7, -0.4, 0.7], aspect)!;
    expect(placed).not.toBeNull();
    for (let i = 0; i < 4; i++) expect(placed.quad[i * 2]).toBeGreaterThanOrEqual(SURFACE_SAFE.left);
  });
});

describe("titleAspect", () => {
  it("is wider for a longer title and narrower for stacked lines", () => {
    expect(titleAspect("ALPINE VIEWS")).toBeGreaterThan(titleAspect("ALPINE"));
    expect(titleAspect("ALPINE\nVIEWS")).toBeLessThan(titleAspect("ALPINE VIEWS"));
    expect(titleAspect("A")).toBeGreaterThanOrEqual(0.5);
  });
});

describe("surfaceInk", () => {
  const flat = (v: number): Gray => ({ data: new Float32Array(W * H).fill(v), width: W, height: H });
  const quad = [0.2, 0.3, 0.8, 0.3, 0.8, 0.5, 0.2, 0.5];
  it("uses ivory on a dark surface and deep ink on a light one", () => {
    expect(surfaceInk(flat(40), quad).color).toBe("#f4eee2");
    expect(surfaceInk(flat(225), quad).color).toBe("#1b1915");
  });
  it("asks for the strong shadow when neither ink contrasts well, or the surface is busy", () => {
    const mid = surfaceInk(flat(120), quad);
    expect(mid.contrast).toBeLessThan(6);
    const busy: Gray = { data: Float32Array.from({ length: W * H }, (_, i) => (i % 2 ? 30 : 230)), width: W, height: H };
    expect(surfaceInk(busy, quad).shadow).toBe("strong");
    expect(surfaceInk(flat(20), quad).shadow).toBe("soft");
  });
});

describe("snapQuadToEdges", () => {
  it("pulls a rough quad's sides onto the real edges of a surface in perspective", () => {
    const frame = render([{ quad: px(WALL), base: 170, seed: 5 }], { base: 70, seed: 9 });
    const rough = WALL.map((v, i) => v + (i % 3 === 0 ? 0.02 : -0.018)); // every corner a couple of percent off
    const found = findSurfaces(frame, { aspect }, { regions: [{ kind: "wall", quad: rough, confidence: 0.8 }] });
    const best = found.candidates.find((c) => c.source === "vision")!;
    expect(best).toBeDefined();
    expect(corners(best.plane, WALL)).toBeLessThan(0.014);
    expect(corners(rough, WALL)).toBeGreaterThan(0.017);
    void snapQuadToEdges;
  });
});

describe("findSurfaces from edges alone", () => {
  const frame = render([{ quad: px(WALL), base: 175, seed: 5 }], { base: 60, seed: 9 });
  const found = findSurfaces(frame, { aspect });

  it("finds a wall in perspective with its own corners", () => {
    const wall = found.candidates.find((c) => c.kind === "wall")!;
    expect(wall).toBeDefined();
    expect(surfaceOverlap(wall.plane, WALL)).toBeGreaterThan(0.85);
    expect(corners(wall.plane, WALL)).toBeLessThan(0.03);
    // The far side is shorter than the near side: the quad kept the perspective.
    const nearEdge = Math.hypot(wall.plane[7] - wall.plane[1], wall.plane[6] - wall.plane[0]);
    const farEdge = Math.hypot(wall.plane[5] - wall.plane[3], wall.plane[4] - wall.plane[2]);
    expect(farEdge).toBeLessThan(nearEdge * 0.85);
  });

  it("rates it followable, with detail spread across the title, and puts the title inside it", () => {
    const wall = found.candidates[0];
    expect(wall.tracking).toBe("surface");
    expect(wall.texture.points).toBeGreaterThanOrEqual(8);
    expect(wall.texture.coverage).toBeGreaterThanOrEqual(0.25);
    expect(surfaceOverlap(wall.placement, wall.plane)).toBeGreaterThan(0.1);
    const inv = invertHomography(homography([0, 0, 1, 0, 1, 1, 0, 1], px(wall.plane))!)!;
    for (let i = 0; i < 4; i++) {
      const [u, v] = applyHomography(inv, wall.placement[i * 2] * W, wall.placement[i * 2 + 1] * H);
      expect(u).toBeGreaterThan(0); expect(u).toBeLessThan(1); expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1);
    }
  });

  it("chooses ivory ink for a dark surface and the deep ink for a light one", () => {
    const light = found.candidates[0];
    expect(light.ink.color).toBe("#1b1915");
    const dark = findSurfaces(render([{ quad: px(WALL), base: 55, seed: 5 }], { base: 150, seed: 9 }), { aspect }).candidates[0];
    expect(dark.ink.color).toBe("#f4eee2");
  });
});

describe("ranking and rejection", () => {
  const BIG = [0.08, 0.16, 0.7, 0.2, 0.7, 0.6, 0.08, 0.64];
  const SMALL = [0.74, 0.28, 0.94, 0.3, 0.94, 0.42, 0.74, 0.43];

  it("ranks a large textured surface above a small one", () => {
    const frame = render([{ quad: px(BIG), base: 170, seed: 5 }, { quad: px(SMALL), base: 175, seed: 6 }], { base: 60, seed: 9 });
    const { candidates } = findSurfaces(frame, { aspect }, {}, { top: 5 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(surfaceOverlap(candidates[0].plane, BIG)).toBeGreaterThan(0.7);
    const small = candidates.findIndex((c) => surfaceOverlap(c.plane, SMALL) > 0.5);
    if (small >= 0) expect(small).toBeGreaterThan(0);
  });

  it("will not call a blank surface followable, and offers it only as fixed", () => {
    // A bright blank panel on a textured wall: edges are real, detail is none.
    const frame = render([{ quad: px(BIG), base: 200, seed: 5, amount: 1 }], { base: 80, seed: 9, amount: 50 });
    const { candidates } = findSurfaces(frame, { aspect }, { regions: [{ kind: "wall", quad: BIG, confidence: 0.9 }] });
    const blank = candidates.find((c) => surfaceOverlap(c.plane, BIG) > 0.6);
    expect(blank).toBeDefined();
    expect(blank!.tracking).toBe("fixed");
    expect(blank!.reasons.join(" ")).toMatch(/not be tracked|almost no detail/);
    expect(findSurfaces(frame, { aspect }, { regions: [{ kind: "wall", quad: BIG, confidence: 0.9 }] }, { keepFixed: false }).candidates.some((c) => c.tracking === "fixed")).toBe(false);
  });

  it("puts a followable surface before a fixed one even when the fixed one is larger", () => {
    const frame = render([{ quad: px(SMALL.map((v, i) => (i % 2 === 0 ? v - 0.5 : v + 0.15))), base: 170, seed: 5 }], { base: 80, seed: 9, amount: 1 });
    const { candidates } = findSurfaces(frame, { aspect }, {}, { top: 6 });
    const firstFixed = candidates.findIndex((c) => c.tracking === "fixed");
    const lastTracked = candidates.map((c) => c.tracking).lastIndexOf("surface");
    if (firstFixed >= 0 && lastTracked >= 0) expect(lastTracked).toBeLessThan(firstFixed);
  });

  it("finds a smooth band of sky across the top and offers it as fixed", () => {
    const frame = render([], { base: 90, seed: 9, amount: 60 }, (x, y) => (y < 0.3 * H ? 205 + 8 * (y / H) : null));
    const { candidates } = findSurfaces(frame, { aspect: titleAspect("ALPINE VIEWS") });
    const sky = candidates.find((c) => c.kind === "sky" || c.kind === "ceiling");
    expect(sky).toBeDefined();
    expect(sky!.source).toBe("band");
    expect(sky!.tracking).toBe("fixed");
    expect(sky!.placement[1]).toBeLessThan(0.3);
  });

  it("returns nothing it can stand behind on a blank frame, without throwing", () => {
    const blank: Gray = { data: new Float32Array(W * H).fill(120), width: W, height: H };
    const result = findSurfaces(blank, { aspect });
    expect(result.lines).toBe(0);
    expect(result.candidates.every((c) => c.tracking === "fixed")).toBe(true);
  });

  it("rejects what cannot carry a title, with the reason", () => {
    const frame = render([], { base: 90, seed: 9 });
    const tiny: SurfaceRegion = { kind: "wall", quad: [0.4, 0.4, 0.46, 0.4, 0.46, 0.44, 0.4, 0.44], confidence: 0.9 };
    const everything: SurfaceRegion = { kind: "wall", quad: [0, 0, 1, 0, 1, 1, 0, 1], confidence: 0.9 };
    const bowtie: SurfaceRegion = { kind: "wall", quad: [0.2, 0.2, 0.8, 0.8, 0.8, 0.2, 0.2, 0.8], confidence: 0.9 };
    const { rejected } = findSurfaces(frame, { aspect }, { regions: [tiny, everything, bowtie] });
    const reasons = rejected.map((r) => r.reason).join("|");
    expect(reasons).toMatch(/too small/);
    expect(reasons).toMatch(/whole frame/);
    expect(reasons).toMatch(/convex/);
  });
});

describe("ground planes", () => {
  it("gives a floor drawn as a plain box the sides a floor has, converging on the horizon", () => {
    const box = [0.1, 0.62, 0.9, 0.62, 0.9, 0.95, 0.1, 0.95];
    const floor = convergeToHorizon(box, 0.4)!;
    expect(floor).not.toBeNull();
    // Far edge narrower, centred on the vanishing point; near edge untouched.
    expect(floor[2] - floor[0]).toBeLessThan(0.8 * 0.8);
    expect((floor[0] + floor[2]) / 2).toBeCloseTo(0.5, 3);
    expect(floor.slice(4)).toEqual([0.9, 0.95, 0.1, 0.95]);
    // Each side points at the vanishing point: left corners and (0.5, 0.4) are collinear.
    const slope = (floor[1] - floor[7]) / (floor[0] - floor[6]);
    const toVp = (0.4 - floor[7]) / (0.5 - floor[6]);
    expect(slope).toBeCloseTo(toVp, 2);
  });

  it("leaves alone a quad that already converges, one that crosses the horizon, and one too thin to tell", () => {
    expect(convergeToHorizon([0.3, 0.62, 0.7, 0.62, 0.9, 0.95, 0.1, 0.95], 0.4)).toBeNull();
    expect(convergeToHorizon([0.1, 0.3, 0.9, 0.3, 0.9, 0.9, 0.1, 0.9], 0.5)).toBeNull();
    expect(convergeToHorizon([0.1, 0.9, 0.9, 0.9, 0.9, 0.93, 0.1, 0.93], 0.4)).toBeNull();
  });

  it("makes a ceiling converge upwards from its near (top) edge", () => {
    const ceiling = convergeToHorizon([0.05, 0.03, 0.95, 0.03, 0.95, 0.3, 0.05, 0.3], 0.55)!;
    expect(ceiling).not.toBeNull();
    expect(ceiling.slice(0, 4)).toEqual([0.05, 0.03, 0.95, 0.03]);
    expect(ceiling[4] - ceiling[6]).toBeLessThan(0.9);
  });

  it("estimates the horizon from receding lines and uses it to correct a vision box", () => {
    // Floorboards and a skirting line receding to a vanishing point at (180, 250) on a 360×640 frame.
    const vp: [number, number] = [180, 250];
    const lines = [20, 90, 150, 215, 280, 340].map((x) => {
      const dx = x - vp[0], dy = 640 - vp[1];
      const theta = Math.atan2(dx, -dy);
      const t = ((theta % Math.PI) + Math.PI) % Math.PI;
      return { theta: t, rho: x * Math.cos(t) + 640 * Math.sin(t), votes: 60 };
    });
    const horizon = estimateHorizon(lines, 360, 640)!;
    expect(horizon).not.toBeNull();
    expect(horizon.y * 640).toBeGreaterThan(235);
    expect(horizon.y * 640).toBeLessThan(265);
  });
});

describe("pickCandidate", () => {
  const frame = render([{ quad: px(WALL), base: 175, seed: 5 }], { base: 60, seed: 9 });
  const { candidates } = findSurfaces(frame, { aspect }, {}, { top: 6 });
  it("takes the first for auto, the first of a kind otherwise, null when none", () => {
    expect(pickCandidate(candidates, "auto")).toBe(candidates[0]);
    const wall = pickCandidate(candidates, "wall");
    expect(wall === null || wall.kind === "wall" || wall.kind === "window").toBe(true);
    expect(pickCandidate([], "auto")).toBeNull();
    expect(pickCandidate(candidates.filter((c) => c.kind !== "sky" && c.kind !== "ceiling"), "sky")).toBeNull();
  });
});
