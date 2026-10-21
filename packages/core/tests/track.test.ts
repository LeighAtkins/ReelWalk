import { describe, expect, it } from "vitest";
import {
  applyHomography, buildPyramid, defaultTolerance, cornerScore, downsample, homography, insideQuad, localShape, lkTrack, mapQuad, minorSpread, quadCoverage, quadIsSane,
  register, selectModel, smoothTrack, supportPoints, trackForwardBackward, trackPath, trackSurface, trackSurfaceAsync, warpGray, IDENTITY, type Gray, type Point, type Quad, type TrackFrame,
} from "../src";
import { cornerError, scenarios, texturedFrame } from "./track-bench/synth";

const W = 144, H = 256;
const flat = (value = 128, width = W, height = H): Gray => ({ data: new Float32Array(width * height).fill(value), width, height });
const shift = (dx: number, dy: number) => [1, 0, dx, 0, 1, dy, 0, 0, 1];
const QUAD: Quad = [43, 85, 101, 85, 101, 131, 43, 131];

describe("pyramid", () => {
  it("halves each level and keeps a flat picture flat", () => {
    const levels = buildPyramid(flat(90), 3);
    expect(levels.map((l) => [l.width, l.height])).toEqual([[144, 256], [72, 128], [36, 64]]);
    expect(Math.max(...levels[2].data)).toBeCloseTo(90, 5);
    expect(Math.min(...levels[2].data)).toBeCloseTo(90, 5);
    expect(Math.max(...levels[2].gx.map(Math.abs))).toBe(0);
  });

  it("stops before a level gets too small", () => {
    expect(buildPyramid(flat(0, 40, 60), 3)).toHaveLength(1);
    expect(downsample(flat(0, 41, 61))).toMatchObject({ width: 20, height: 30 });
  });
});

describe("support region", () => {
  it("scores a blank wall and a single edge near zero and texture high", () => {
    const blank = buildPyramid(flat(), 1)[0];
    const edge = flat(); for (let y = 0; y < H; y++) for (let x = 72; x < W; x++) edge.data[y * W + x] = 200;
    const textured = buildPyramid(texturedFrame(W, H), 1)[0];
    expect(cornerScore(blank, 70, 100, 5)).toBe(0);
    expect(cornerScore(buildPyramid(edge, 1)[0], 72, 100, 5)).toBeLessThan(1e-6);
    expect(cornerScore(textured, 70, 100, 5)).toBeGreaterThan(8);
  });

  it("takes points only inside the quad, with a margin, even when everything outside is textured", () => {
    // Texture everywhere, a perspective quad: nothing may come from outside it.
    const level = buildPyramid(texturedFrame(W, H), 1)[0];
    const quad: Quad = [40, 80, 110, 95, 105, 140, 45, 128];
    const points = supportPoints(level, quad, { margin: 6 });
    expect(points.length).toBeGreaterThan(20);
    for (const [x, y] of points) expect(insideQuad(quad, x, y, 6)).toBe(true);
    // ...and they spread over the surface rather than bunching.
    expect(quadCoverage(points, quad, W, H).coverage).toBeGreaterThan(0.9);
  });

  it("finds nothing on a blank surface surrounded by texture", () => {
    const frame = texturedFrame(W, H);
    for (let y = 70; y < 150; y++) for (let x = 30; x < 115; x++) frame.data[y * W + x] = 140;
    expect(supportPoints(buildPyramid(frame, 1)[0], QUAD)).toEqual([]);
  });

  it("is deterministic", () => {
    const level = buildPyramid(texturedFrame(W, H), 1)[0];
    expect(supportPoints(level, QUAD)).toEqual(supportPoints(level, QUAD));
  });
});

describe("Lucas–Kanade", () => {
  // A band-limited picture (a sum of sinusoids), so a fractional shift is a true translation of it.
  const smooth = (h: number[] = shift(0, 0)): Gray => {
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = x - h[2], v = y - h[5];
      data[y * W + x] = 128 + 40 * Math.sin(0.31 * u + 0.17 * v) + 35 * Math.sin(0.13 * u - 0.37 * v + 1) + 30 * Math.sin(0.05 * u + 0.43 * v + 2) + 20 * Math.sin(0.53 * u + 0.29 * v + 3);
    }
    return { data, width: W, height: H };
  };
  const a = buildPyramid(smooth(), 3);
  const points: Point[] = [[60, 100], [80, 110], [70, 120], [90, 95]];

  it("recovers a sub-pixel shift", () => {
    const b = buildPyramid(smooth(shift(1.3, -0.7)), 3);
    lkTrack(a, b, points).forEach((r, i) => {
      expect(r.ok).toBe(true);
      expect(Math.hypot(r.point[0] - points[i][0] - 1.3, r.point[1] - points[i][1] + 0.7)).toBeLessThan(0.1);
    });
  });

  it("follows a large shift through the pyramid that one level would miss", () => {
    // Integer shift of the (aperiodic) benchmark texture: only the pyramid's reach is being tested.
    const a = buildPyramid(texturedFrame(W, H, shift(0, 0), 11, 0, 2), 3);
    const b = buildPyramid(texturedFrame(W, H, shift(9, 6), 11, 0, 2), 3);
    const three = lkTrack(a, b, points);
    three.forEach((r, i) => { expect(r.ok).toBe(true); expect(Math.hypot(r.point[0] - points[i][0] - 9, r.point[1] - points[i][1] - 6)).toBeLessThan(0.2); });
    const one = lkTrack(a.slice(0, 1), b.slice(0, 1), points);
    expect(one.some((r, i) => !r.ok || Math.hypot(r.point[0] - points[i][0] - 9, r.point[1] - points[i][1] - 6) > 1)).toBe(true);
  });

  it("uses a guess", () => {
    const b = buildPyramid(smooth(shift(20, 0)), 2);
    const guessed = lkTrack(a.slice(0, 2), b, points, points.map(([x, y]) => [x + 19, y] as Point));
    guessed.forEach((r, i) => expect(Math.hypot(r.point[0] - points[i][0] - 20, r.point[1] - points[i][1])).toBeLessThan(0.2));
  });

  it("fails on a blank patch", () => {
    expect(lkTrack(buildPyramid(flat(), 3), buildPyramid(flat(), 3), points).every((r) => !r.ok)).toBe(true);
  });
});

describe("forward–backward check", () => {
  it("keeps points that round-trip and drops points something covered", () => {
    const a = buildPyramid(texturedFrame(W, H), 3);
    const next = texturedFrame(W, H, shift(2, 1));
    const other = texturedFrame(W, H, shift(2, 1), 99);
    for (let y = 0; y < H; y++) for (let x = 80; x < W; x++) next.data[y * W + x] = other.data[y * W + x]; // a different picture on the right
    const points: Point[] = [[40, 100], [50, 130], [110, 100], [120, 130]];
    const fb = trackForwardBackward(a, buildPyramid(next, 3), points);
    expect(fb.ok.slice(0, 2)).toEqual([true, true]);
    expect(fb.ok.slice(2)).toEqual([false, false]);
    expect(fb.fb[0]).toBeLessThan(0.1);
  });
});

describe("model selection", () => {
  const grid: Point[] = [];
  for (let y = 85; y <= 131; y += 9) for (let x = 43; x <= 101; x += 9) grid.push([x, y]);
  const moved = (h: number[], pts = grid) => pts.map(([x, y]) => applyHomography(h, x, y) as Point);

  it("prefers a similarity for a pan", () => {
    const sel = selectModel(grid, moved(shift(3, -2)), QUAD);
    expect(sel.ok && sel.model).toBe("similarity");
  });

  it("takes a homography only when the points support one", () => {
    const persp = homography(QUAD, [43, 85, 101, 88, 100, 128, 43, 131])!;
    const sel = selectModel(grid, moved(persp), QUAD, { tolerance: 0.3 });
    expect(sel.ok && sel.model).toBe("homography");
    // The same motion seen through six points in one corner is not enough for a homography.
    const few = grid.filter(([x, y]) => x < 70 && y < 105);
    const sel2 = selectModel(few, moved(persp, few), QUAD, { tolerance: 0.3, minSpread: { similarity: 0 } });
    expect(sel2.ok && sel2.model).not.toBe("homography");
  });

  it("refuses points along one line as degenerate", () => {
    const line: Point[] = Array.from({ length: 12 }, (_, i) => [45 + i * 5, 100]);
    const sel = selectModel(line, moved(shift(1, 1), line), QUAD);
    expect(sel).toMatchObject({ ok: false, reason: "degenerate-motion" });
    expect(minorSpread(line)).toBe(0);
  });

  it("refuses a shear no camera step makes", () => {
    const shear = [1, 0.5, -50, 0, 1, 0, 0, 0, 1];
    expect(localShape(shear, [72, 108]).shear).toBeLessThan(-20);
    expect(selectModel(grid, moved(shear), QUAD)).toMatchObject({ ok: false, reason: "degenerate-motion" });
  });

  it("takes an affine for a 4% stretch even though the similarity's agreeing points are a line (regression)", () => {
    // 56 well-spread exact correspondences, stretched 4% horizontally about the quad's centre.
    const pts: Point[] = [];
    for (let y = 0; y < 7; y++) for (let x = 0; x < 8; x++) pts.push([45 + x * 8, 87 + y * 7]);
    const stretch = [1.04, 0, -0.04 * 72, 0, 1, 0, 0, 0, 1];
    const sel = selectModel(pts, moved(stretch, pts), QUAD);
    expect(sel.ok).toBe(true);
    if (sel.ok) { expect(sel.model).not.toBe("similarity"); expect(sel.inliers.length).toBe(56); }
  });

  it("refuses too few points", () => {
    expect(selectModel(grid.slice(0, 4), moved(shift(1, 0), grid.slice(0, 4)), QUAD)).toMatchObject({ ok: false, reason: "too-few-features" });
  });

  it("knows a sane quad from a collapsed or bow-tie one", () => {
    expect(quadIsSane(QUAD)).toBe(true);
    expect(quadIsSane([0, 0, 50, 0, 0, 50, 50, 50])).toBe(false);
    expect(quadIsSane([0, 0, 50, 0, 50, 0.01, 0, 0.01])).toBe(false);
  });
});

describe("drift correction", () => {
  it("re-registers a drifted prediction onto the reference", () => {
    const truth = homography(QUAD, [40, 82, 104, 88, 100, 136, 44, 130])!;
    const refFrame = texturedFrame(W, H);
    const levels = buildPyramid(refFrame, 3);
    const ref = { levels, points: supportPoints(levels[0], QUAD), quad: QUAD };
    const frame = texturedFrame(W, H, truth);
    const drifted = [...truth]; drifted[2] += 1.5; drifted[5] -= 1; // 1.5 px and 1 px of accumulated drift
    expect(cornerError(mapQuad(drifted, QUAD), mapQuad(truth, QUAD))).toBeGreaterThan(1);
    const fixed = register(ref, frame, drifted);
    expect(fixed.ok).toBe(true);
    if (fixed.ok) expect(cornerError(mapQuad(fixed.h, QUAD), mapQuad(truth, QUAD))).toBeLessThan(0.25);
  });

  it("re-registers a 4% stretch from an unstretched prediction (same selector, regression)", () => {
    const levels = buildPyramid(texturedFrame(W, H), 3);
    const ref = { levels, points: supportPoints(levels[0], QUAD), quad: QUAD };
    const stretch = [1.04, 0, -0.04 * 72, 0, 1, 0, 0, 0, 1];
    const fixed = register(ref, texturedFrame(W, H, stretch), IDENTITY);
    expect(fixed.ok).toBe(true);
    if (fixed.ok) expect(cornerError(mapQuad(fixed.h, QUAD), mapQuad(stretch, QUAD))).toBeLessThan(0.3);
  });

  it("warps a frame back into the reference", () => {
    const frame = texturedFrame(W, H, shift(5, 3));
    const back = warpGray(frame, shift(5, 3), W, H);
    const ref = texturedFrame(W, H);
    let diff = 0, n = 0;
    for (let y = 20; y < H - 20; y++) for (let x = 20; x < W - 20; x++) { diff += Math.abs(back.data[y * W + x] - ref.data[y * W + x]); n++; }
    expect(diff / n).toBeLessThan(1);
  });

  it("keeps a long push-in on the truth", () => {
    const push = scenarios(W, H, 24).find((s) => s.name === "push-in")!;
    const result = trackSurface(push.frames, [{ index: 0, quad: push.quad }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stats.corrections).toBeGreaterThan(3);
    expect(cornerError(result.frames.at(-1)!.quad, push.truth.at(-1)!)).toBeLessThan(1);
  });
});

describe("scoring", () => {
  it("measures coverage of the quad, not the number of points", () => {
    const corner: Point[] = Array.from({ length: 30 }, (_, i) => [45 + (i % 5), 87 + Math.floor(i / 5)]);
    expect(quadCoverage(corner, QUAD, W, H).coverage).toBeCloseTo(1 / 16, 5);
    const spread: Point[] = [];
    for (let v = 0; v < 4; v++) for (let u = 0; u < 4; u++) spread.push([43 + (u + 0.5) * 14.5, 85 + (v + 0.5) * 11.5]);
    expect(quadCoverage(spread, QUAD, W, H).coverage).toBe(1);
    // Half the quad out of frame: coverage is over the visible half.
    const off: Quad = [-29, 85, 29, 85, 29, 131, -29, 131];
    expect(quadCoverage([[15, 100], [15, 125], [22, 92], [22, 110], [8, 92], [8, 118], [25, 125], [3, 128]], off, W, H)).toMatchObject({ visible: 0.5 });
  });

  it("gives confident frames on a textured pan and drops confidence while an occluder covers the surface", () => {
    const set = scenarios(W, H, 24);
    const pan = trackSurface(set[0].frames, [{ index: 0, quad: set[0].quad }]);
    expect(pan.ok && pan.frames.every((f) => f.confidence >= 0.5)).toBe(true);
    const heavy = set.find((s) => s.name === "heavy occluder")!;
    const occluded = trackSurface(heavy.frames, [{ index: 0, quad: heavy.quad }]);
    expect(occluded.ok).toBe(true);
    if (!occluded.ok) return;
    const covered = occluded.frames.slice(9, 13);
    expect(covered.every((f) => f.confidence < 0.5)).toBe(true);
    // Frames it does claim are right.
    for (const f of occluded.frames) if (f.confidence >= 0.5) expect(cornerError(f.quad, heavy.truth[f.index])).toBeLessThan(1.2);
  });
});

describe("rejection", () => {
  it("refuses a blank wall: too few features inside", () => {
    const blank = scenarios(W, H, 6).find((s) => s.name === "blank wall")!;
    const r = trackSurface(blank.frames, [{ index: 0, quad: blank.quad }]);
    expect(r).toMatchObject({ ok: false, reason: "too-few-features", frame: 0 });
    if (!r.ok) expect(r.message).toMatch(/Could not follow this surface/);
  });

  it("refuses a surface lost straight away", () => {
    const frames = [texturedFrame(W, H), texturedFrame(W, H, shift(0, 0), 51), texturedFrame(W, H, shift(2, 0), 52), texturedFrame(W, H, shift(4, 0), 53), texturedFrame(W, H, shift(6, 0), 54)];
    const r = trackSurface(frames, [{ index: 0, quad: QUAD }]);
    expect(r).toMatchObject({ ok: false, reason: "plane-lost", frame: 1 });
  });

  it("reports where a plane was lost after a cut, and keeps the frames before it", () => {
    const cut = scenarios(W, H, 16).find((s) => s.name === "cut mid-shot")!;
    const r = trackSurface(cut.frames, [{ index: 0, quad: cut.quad }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lostAt).toBe(8);
    expect(r.lostReason).toBe("plane-lost");
    expect(r.message).toMatch(/lost at frame 8/);
    expect(r.frames.slice(8).every((f) => f.lost && f.confidence === 0)).toBe(true);
    expect(r.frames.slice(1, 8).every((f) => !f.lost && cornerError(f.quad, cut.truth[f.index]) < 1)).toBe(true);
  });

  it("refuses degenerate motion", () => {
    // The picture shears a little more every frame: each step on its own is a strong shear.
    const frames = [0, 1, 2, 3, 4].map((k) => texturedFrame(W, H, [1, 0.12 * k, -0.12 * k * 108, 0, 1, 0, 0, 0, 1]));
    const r = trackSurface(frames, [{ index: 0, quad: QUAD }], { minPoints: 8 });
    expect(r).toMatchObject({ ok: false, reason: "degenerate-motion" });
  });
});

describe("manual correction keyframes", () => {
  const pan = scenarios(W, H, 16)[0];

  it("tracks outward both ways from a quad corrected at frame k", () => {
    const k = 9;
    const r = trackSurface(pan.frames, [{ index: k, quad: pan.truth[k] }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frames[k].anchor).toBe(true);
    expect(r.frames[k].quad).toEqual(pan.truth[k]);
    for (const f of r.frames) expect(cornerError(f.quad, pan.truth[f.index])).toBeLessThan(0.6);
  });

  it("pulls a wrong start onto the surface around a later correction", () => {
    // The author's first quad is 3 px off; a correction at frame 12 says where it really is.
    const wrong = pan.quad.map((v, i) => (i % 2 === 0 ? v + 3 : v)) as Quad;
    const one = trackSurface(pan.frames, [{ index: 0, quad: wrong }]);
    const two = trackSurface(pan.frames, [{ index: 0, quad: wrong }, { index: 12, quad: pan.truth[12] }]);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(two.frames[12].quad).toEqual(pan.truth[12]);
    expect(cornerError(two.frames[10].quad, pan.truth[10])).toBeLessThan(cornerError(one.frames[10].quad, pan.truth[10]));
    expect(cornerError(two.frames[15].quad, pan.truth[15])).toBeLessThan(0.6);
  });
});

const trackFrame = (index: number, quad: Quad, extra: Partial<TrackFrame> = {}): TrackFrame => ({
  index, quad, confidence: 1, attachment: 1, coverage: 1, error: 0.1, uncertaintyPx: 0.05, inliers: 40, model: "similarity", held: false, lost: false, registered: false, anchor: false, ...extra,
});
const at = (x: number): Quad => [x, 10, x + 50, 10, x + 50, 40, x, 40];

describe("smoothing", () => {
  it("keeps a real camera jolt: a confident frame moves no further than its own uncertainty (regression)", () => {
    // Textured frames translated by [0, 0, 0, 10, 0, 0, 0] px: the jolt at frame 3 is real and measured exactly.
    const offsets = [0, 0, 0, 10, 0, 0, 0];
    const frames = offsets.map((dx) => texturedFrame(360, 640, shift(dx, 0)));
    const quad: Quad = [108, 211, 252, 211, 252, 326, 108, 326];
    const truth = offsets.map((dx) => quad.map((v, i) => (i % 2 === 0 ? v + dx : v)) as Quad);
    const raw = trackSurface(frames, [{ index: 0, quad }]);
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    expect(cornerError(raw.frames[3].quad, truth[3])).toBeLessThan(0.1);
    expect(raw.frames[3].confidence).toBeGreaterThan(0.5);
    // The editor's bound: max(5 × uncertainty, the inlier tolerance, 1.08 px at 360 wide).
    const floorPx = defaultTolerance(360);
    const smooth = smoothTrack(raw.frames, { floorPx });
    for (let i = 0; i < smooth.length; i++) {
      expect(cornerError(smooth[i].quad, truth[i]), `frame ${i}`).toBeLessThanOrEqual(0.1 + Math.max(5 * (raw.frames[i].uncertaintyPx ?? 0), floorPx) * Math.SQRT2);
    }
    // An unbounded 1-2-1 smoother would have carried frame 3 most of the way back (the review measured 6.25 px).
    expect(cornerError(smooth[3].quad, truth[3])).toBeLessThan(1.6);
    expect(cornerError(smoothTrack(raw.frames, { floorPx: 100, k: 0 })[3].quad, truth[3])).toBeGreaterThan(5);
  });

  it("never moves an author anchor, even inside a run", () => {
    const frames = [0, 0, 8, 0, 0].map((x, i) => trackFrame(i, at(x), { uncertaintyPx: 10, anchor: i === 2 }));
    const out = smoothTrack(frames);
    expect(out[2].quad).toEqual(at(8));
    expect(out[1].quad[0]).toBeGreaterThan(0); // its neighbours, with a wide bound, are smoothed towards it
  });

  it("keeps held and lost frames out of measured runs", () => {
    const frames = [0, 0, 0, 30, 3, 3, 3].map((x, i) => trackFrame(i, at(x), { uncertaintyPx: 10, held: i === 3 }));
    const out = smoothTrack(frames);
    expect(out[3].quad).toEqual(at(30));
    expect(out.slice(0, 3).map((f) => f.quad[0])).toEqual([0, 0, 0]);
    expect(out.slice(4).map((f) => f.quad[0])).toEqual([3, 3, 3]);
  });

  it("bounds smoothing by max(k × uncertainty, floor)", () => {
    const frames = [0, 2, 0, 2, 0].map((x, i) => trackFrame(i, at(x), { uncertaintyPx: 0.06 }));
    const out = smoothTrack(frames, { k: 5, floorPx: 0.2 });
    out.forEach((f, i) => expect(Math.abs(f.quad[0] - frames[i].quad[0])).toBeLessThanOrEqual(0.3 + 1e-9));
    // With the editor's floor the same shimmer is smoothed down.
    const floored = smoothTrack(frames, { floorPx: 1.08 });
    expect(Math.abs(floored[2].quad[0] - floored[1].quad[0])).toBeLessThan(Math.abs(frames[2].quad[0] - frames[1].quad[0]) / 2);
  });
});

describe("saved path", () => {
  const size = { width: 100, height: 100 };

  it("hides stale geometry: lost frames are o = 0 at the nearest measured corners, the re-found frame is opaque (regression)", () => {
    const frames = [
      trackFrame(0, at(0), { anchor: true }), trackFrame(1, at(1)),
      trackFrame(2, at(1), { lost: true, held: true, confidence: 0 }), trackFrame(3, at(1), { lost: true, held: true, confidence: 0 }), trackFrame(4, at(1), { lost: true, held: true, confidence: 0 }),
      trackFrame(5, at(9), { registered: true }), trackFrame(6, at(10)),
    ];
    const { path, confidence } = trackPath(frames, [0, 100, 200, 300, 400, 500, 600], { fromMs: 0, toMs: 600 }, { x: 0.25, y: 0.25 }, size);
    expect(path.map((p) => p.o ?? 1)).toEqual([1, 1, 0, 0, 0, 1, 1]);
    expect(confidence.slice(2, 5)).toEqual([0, 0, 0]);
    // First half of the gap keeps the last measured corners, second half already carries the re-found ones.
    expect(path[2].q[0]).toBeCloseTo(0.01, 4);
    expect(path[3].q[0]).toBeCloseTo(0.01, 4);
    expect(path[4].q[0]).toBeCloseTo(0.09, 4);
    expect(path[5].q[0]).toBeCloseTo(0.09, 4);
  });

  it("gives a one-frame gap the next measured corners, so the fade in does not slide (regression)", () => {
    // Runs from two anchors meet across a single lost frame 20 px apart.
    const frames = [trackFrame(0, at(0), { anchor: true }), trackFrame(1, at(0)), trackFrame(2, at(0), { lost: true, held: true, confidence: 0 }), trackFrame(3, at(20), { anchor: true })];
    const { path } = trackPath(frames, [0, 100, 200, 300], { fromMs: 0, toMs: 300 }, { x: 0.25, y: 0.25 }, size);
    expect(path[2].o).toBe(0);
    expect(path[2].q).toEqual(path[3].q);
  });

  it("interpolates a held (refused) frame instead of repeating stale corners", () => {
    const frames = [trackFrame(0, at(0), { anchor: true }), trackFrame(1, at(0), { held: true, confidence: 0 }), trackFrame(2, at(4))];
    const { path } = trackPath(frames, [0, 100, 200], { fromMs: 0, toMs: 200 }, { x: 0.25, y: 0.25 }, size);
    expect(path[1].q[0]).toBeCloseTo(0.02, 4);
    expect(path[1].o).toBeUndefined();
  });

  it("times keyframes over the pin's interval and holds the end point (regression)", () => {
    // A 250 ms pin sampled at 0, 100, 200 ms: t must be 0, 0.4, 0.8 then a held point at 1, not 0, 0.5, 1.
    const frames = [0, 1, 2].map((i) => trackFrame(i, at(i), { anchor: i === 0 }));
    const { path } = trackPath(frames, [0, 100, 200], { fromMs: 0, toMs: 250 }, { x: 0.25, y: 0.25 }, size);
    expect(path.map((p) => p.t)).toEqual([0, 0.4, 0.8, 1]);
    expect(path[3].q).toEqual(path[2].q);
  });
});

describe("scheduling", () => {
  it("gives the same result asynchronously, handing the thread back between steps", async () => {
    const s = scenarios(W, H, 8)[0];
    const sync = trackSurface(s.frames, [{ index: 0, quad: s.quad }]);
    let yields = 0;
    const progress: number[] = [];
    const async = await trackSurfaceAsync(s.frames, [{ index: 0, quad: s.quad }], { yieldEvery: 1, yieldTo: async () => { yields++; }, onProgress: (f) => progress.push(f) });
    expect(JSON.stringify(async)).toBe(JSON.stringify(sync));
    expect(yields).toBe(7);
    expect(progress.at(-1)).toBe(1);
  });
});

describe("determinism", () => {
  it("gives identical output for identical input", () => {
    const set = scenarios(W, H, 10);
    for (const s of [set[2], set[4]]) {
      const a = trackSurface(s.frames, [{ index: 0, quad: s.quad }]);
      const b = trackSurface(s.frames, [{ index: 0, quad: s.quad }]);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
