/**
 * Surface tracking (ADR 0052): follow the flat surface an author placed a
 * title on through a run of frames, and say honestly how well it was
 * followed, frame by frame.
 *
 * The pipeline, in order:
 *
 * 1. **Support region.** Features are chosen strictly inside the author's quad
 *    (inset by a margin so a feature's window does not straddle the edge onto
 *    another depth plane), spread over the quad's area by binning in the
 *    quad's own coordinates. Nothing outside is used unless the caller passes
 *    a wider `support` quad on purpose.
 * 2. **Pyramidal Lucas–Kanade** point tracking over two or three levels, with
 *    a constant-velocity guess from the previous step.
 * 3. **Forward–backward consistency**: every point is tracked back again and
 *    dropped if it does not land where it started.
 * 4. **Robust model selection** per step: similarity, then affine, then a
 *    homography, each only when the points support it (more agreement, enough
 *    spread) and the step is not degenerate (shear, aspect, scale, rotation,
 *    a quad that stays convex).
 * 5. **Drift correction**: every few frames (and after any held step) the
 *    current frame is warped back into the reference frame by the predicted
 *    plane and re-registered against the reference features, so error does
 *    not accumulate step by step.
 * 6. **Scoring**: each frame gets an attachment score from the *coverage* of
 *    the quad by agreeing features and the reprojection error of all tracked
 *    points (not the inlier count), a visibility term, and a corner
 *    uncertainty in pixels.
 *
 * It refuses rather than guesses: too few features inside, the plane lost at
 * frame k, or degenerate motion come back as a reason. Author corrections
 * ("anchors": the right quad at frame k) re-track outward from each anchor
 * and blend between neighbours.
 *
 * Pure arithmetic on `Gray` frames (Float32 luminance 0–255) in pixels;
 * deterministic (the only randomness is RANSAC's seeded generator).
 */
import { applyHomography, homography, invertHomography, robustFit, type Gray, type PlaneModel, type Quad } from "./motion";

export type Point = [number, number];

/** One pyramid level: the picture and its central-difference gradients. */
export type Level = Gray & { gx: Float32Array; gy: Float32Array };

// ---------------------------------------------------------------- images

/** Bilinear sample of a row-major plane, clamped at the borders. */
function sampleAt(data: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = x0 + 1 < width ? x0 + 1 : x0, y1 = y0 + 1 < height ? y0 + 1 : y0;
  const fx = cx - x0, fy = cy - y0;
  const a = data[y0 * width + x0], b = data[y0 * width + x1], c = data[y1 * width + x0], d = data[y1 * width + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** The picture's value at a fractional position (bilinear, clamped). */
export function sampleGray(g: Gray, x: number, y: number): number {
  return sampleAt(g.data, g.width, g.height, x, y);
}

/** Half the size, after a 5-tap binomial blur so the smaller level does not alias. */
export function downsample(g: Gray): Gray {
  const { width: W, height: H, data } = g;
  const w = Math.max(1, Math.floor(W / 2)), h = Math.max(1, Math.floor(H / 2));
  const k = [1, 4, 6, 4, 1];
  const clamp = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  const tmp = new Float32Array(w * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * data[y * W + clamp(2 * x + i, W)];
    tmp[y * w + x] = s / 16;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += k[j + 2] * tmp[clamp(2 * y + j, H) * w + x];
    out[y * w + x] = s / 16;
  }
  return { data: out, width: w, height: h };
}

function withGradients(g: Gray): Level {
  const { width: w, height: h, data } = g;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    gx[i] = ((x + 1 < w ? data[i + 1] : data[i]) - (x > 0 ? data[i - 1] : data[i])) / 2;
    gy[i] = ((y + 1 < h ? data[i + w] : data[i]) - (y > 0 ? data[i - w] : data[i])) / 2;
  }
  return { ...g, gx, gy };
}

/** A Gaussian pyramid of up to `levels` levels (level 0 is the frame), each with gradients. Stops before a level is under 24 px. */
export function buildPyramid(g: Gray, levels = 3): Level[] {
  const out: Level[] = [withGradients(g)];
  while (out.length < levels && Math.min(out[out.length - 1].width, out[out.length - 1].height) >= 48) out.push(withGradients(downsample(out[out.length - 1])));
  return out;
}

/** Shi–Tomasi corner strength at (x, y): the smaller eigenvalue of the mean structure tensor over a (2r+1)² window. Near zero on a blank wall or along a single edge. */
export function cornerScore(level: Level, x: number, y: number, radius: number): number {
  let sxx = 0, syy = 0, sxy = 0, n = 0;
  const { width: w, height: h, gx, gy } = level;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const px = Math.round(x) + dx, py = Math.round(y) + dy;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = py * w + px;
    sxx += gx[i] * gx[i]; syy += gy[i] * gy[i]; sxy += gx[i] * gy[i]; n++;
  }
  if (!n) return 0;
  sxx /= n; syy /= n; sxy /= n;
  return (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
}

// ---------------------------------------------------------------- quads

const UNIT: Quad = [0, 0, 1, 0, 1, 1, 0, 1];

export function mulHomography(p: number[], q: number[]): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = p[r * 3] * q[c] + p[r * 3 + 1] * q[3 + c] + p[r * 3 + 2] * q[6 + c];
  const s = out[8] || 1;
  return out.map((v) => v / s);
}

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mapQuad(h: number[], quad: Quad): Quad {
  return [0, 1, 2, 3].flatMap((i) => applyHomography(h, quad[i * 2], quad[i * 2 + 1])) as Quad;
}

function signedArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; a += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1]; }
  return a / 2;
}

/** Whether (x, y) lies inside the quad by at least `margin` pixels from every edge (convex quads, either winding). */
export function insideQuad(quad: Quad, x: number, y: number, margin = 0): boolean {
  const sign = Math.sign(signedArea(quad)) || 1;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const ax = quad[i * 2], ay = quad[i * 2 + 1], bx = quad[j * 2], by = quad[j * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    const d = (((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / len) * sign;
    if (d < margin) return false;
  }
  return true;
}

/** A usable plane: convex, not collapsed, every interior angle between `minAngle` and 180 − `minAngle` degrees. */
export function quadIsSane(quad: Quad, minAngle = 15): boolean {
  if (quad.some((v) => !Number.isFinite(v))) return false;
  const area = signedArea(quad);
  if (Math.abs(area) < 1) return false;
  const sign = Math.sign(area);
  for (let i = 0; i < 4; i++) {
    const p = (i + 3) % 4, n = (i + 1) % 4;
    const ax = quad[p * 2] - quad[i * 2], ay = quad[p * 2 + 1] - quad[i * 2 + 1];
    const bx = quad[n * 2] - quad[i * 2], by = quad[n * 2 + 1] - quad[i * 2 + 1];
    const cross = (bx * ay - by * ax) * sign;
    if (cross <= 0) return false; // reflex or flipped corner
    const angle = (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1e-9)))) * 180) / Math.PI;
    if (angle < minAngle || angle > 180 - minAngle) return false;
  }
  return true;
}

/** Mean width over mean height of a (tl, tr, br, bl) quad: how stretched the title would be. */
export function quadAspect(q: Quad): number {
  const top = Math.hypot(q[2] - q[0], q[3] - q[1]), bottom = Math.hypot(q[4] - q[6], q[5] - q[7]);
  const left = Math.hypot(q[6] - q[0], q[7] - q[1]), right = Math.hypot(q[4] - q[2], q[5] - q[3]);
  return (top + bottom) / Math.max(1e-9, left + right);
}

/** What a transform does near a point: scale, rotation (deg), shear (deg away from square) and aspect (x stretch over y stretch). */
export function localShape(h: number[], at: Point): { scale: number; rotation: number; shear: number; aspect: number } {
  const d = 5;
  const [x0, y0] = applyHomography(h, at[0], at[1]);
  const [x1, y1] = applyHomography(h, at[0] + d, at[1]);
  const [x2, y2] = applyHomography(h, at[0], at[1] + d);
  const ax = (x1 - x0) / d, ay = (y1 - y0) / d, bx = (x2 - x0) / d, by = (y2 - y0) / d;
  const sx = Math.hypot(ax, ay), sy = Math.hypot(bx, by);
  const between = (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / ((sx * sy) || 1e-9)))) * 180) / Math.PI;
  return { scale: Math.sqrt(sx * sy), rotation: (Math.atan2(ay, ax) * 180) / Math.PI, shear: between - 90, aspect: sx / (sy || 1e-9) };
}

function quadCentre(q: Quad): Point {
  return [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];
}

/**
 * How much of the quad the points cover: the quad is divided into `cells`²
 * cells in its own coordinates; `coverage` is the share of cells inside the
 * frame that hold at least one point, `visible` the share of cells inside the
 * frame at all.
 */
export function quadCoverage(points: Point[], quad: Quad, width: number, height: number, cells = 4): { coverage: number; visible: number } {
  const toUnit = homography(quad, UNIT), fromUnit = homography(UNIT, quad);
  if (!toUnit || !fromUnit) return { coverage: 0, visible: 0 };
  const occupied = new Set<number>();
  for (const p of points) {
    const [u, v] = applyHomography(toUnit, p[0], p[1]);
    if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
    occupied.add(Math.floor(v * cells) * cells + Math.floor(u * cells));
  }
  let visible = 0, hit = 0;
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
    const [x, y] = applyHomography(fromUnit, (cx + 0.5) / cells, (cy + 0.5) / cells);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    visible++;
    if (occupied.has(cy * cells + cx)) hit++;
  }
  return { coverage: visible ? hit / visible : 0, visible: visible / (cells * cells) };
}

// ---------------------------------------------------------------- features

export type SupportOptions = { margin?: number; maxPoints?: number; window?: number; minCorner?: number };

/**
 * Points worth tracking on a surface: candidates strictly inside `quad` (at
 * least `margin` px from every edge, and a window clear of the frame edge),
 * scored by corner strength, the best one per cell of the quad's own grid
 * kept when it clears `minCorner`, so the points spread over the surface's
 * area rather than bunching on its busiest corner. Ordered by cell, so the
 * same frame and quad always give the same list.
 */
export function supportPoints(level: Level, quad: Quad, { margin = 6, maxPoints = 80, window = 5, minCorner = 8 }: SupportOptions = {}): Point[] {
  const { width, height } = level;
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
  const edge = window + 1;
  const x0 = Math.max(edge, Math.floor(Math.min(...xs))), x1 = Math.min(width - 1 - edge, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(edge, Math.floor(Math.min(...ys))), y1 = Math.min(height - 1 - edge, Math.ceil(Math.max(...ys)));
  if (x1 <= x0 || y1 <= y0) return [];
  const area = Math.abs(signedArea(quad));
  const step = Math.max(2, Math.floor(Math.sqrt(area / (maxPoints * 6))));
  const cells = Math.max(2, Math.ceil(Math.sqrt(maxPoints)));
  const toUnit = homography(quad, UNIT);
  if (!toUnit) return [];
  const best = new Map<number, { p: Point; score: number }>();
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
    if (!insideQuad(quad, x, y, margin)) continue;
    const score = cornerScore(level, x, y, window);
    if (score < minCorner) continue;
    const [u, v] = applyHomography(toUnit, x, y);
    const cell = Math.min(cells - 1, Math.max(0, Math.floor(v * cells))) * cells + Math.min(cells - 1, Math.max(0, Math.floor(u * cells)));
    const held = best.get(cell);
    if (!held || score > held.score) best.set(cell, { p: [x, y], score });
  }
  let picked = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (picked.length > maxPoints) {
    const floor = [...picked].sort((a, b) => b.score - a.score)[maxPoints - 1].score;
    picked = picked.filter((v) => v.score >= floor).slice(0, maxPoints);
  }
  return picked.map((v) => v.p);
}

// ---------------------------------------------------------------- point tracking

export type LkOptions = { window?: number; iterations?: number; epsilon?: number; maxResidual?: number };
export type LkResult = { point: Point; ok: boolean; residual: number };

/**
 * Pyramidal Lucas–Kanade: where each point of `prev` went in `next`,
 * coarse to fine, starting from `guesses` (full-resolution positions) when
 * given. A point fails when its window has no texture to solve with, when it
 * leaves the frame, or when the matched window differs by more than
 * `maxResidual` grey levels on average (something covered it).
 */
export function lkTrack(prev: Level[], next: Level[], points: Point[], guesses?: Point[], { window = 5, iterations = 15, epsilon = 0.01, maxResidual = 20 }: LkOptions = {}): LkResult[] {
  const levels = Math.min(prev.length, next.length);
  const side = 2 * window + 1, count = side * side;
  const T = new Float32Array(count), IX = new Float32Array(count), IY = new Float32Array(count);
  return points.map((p, idx) => {
    const top = 2 ** (levels - 1);
    let gx = guesses ? (guesses[idx][0] - p[0]) / top : 0, gy = guesses ? (guesses[idx][1] - p[1]) / top : 0;
    let failed = false;
    for (let l = levels - 1; l >= 0; l--) {
      const P = prev[l], N = next[l], s = 2 ** l;
      const px = p[0] / s, py = p[1] / s;
      let gxx = 0, gxy = 0, gyy = 0, k = 0;
      for (let dy = -window; dy <= window; dy++) for (let dx = -window; dx <= window; dx++, k++) {
        const ix = sampleAt(P.gx, P.width, P.height, px + dx, py + dy), iy = sampleAt(P.gy, P.width, P.height, px + dx, py + dy);
        T[k] = sampleAt(P.data, P.width, P.height, px + dx, py + dy); IX[k] = ix; IY[k] = iy;
        gxx += ix * ix; gxy += ix * iy; gyy += iy * iy;
      }
      const det = gxx * gyy - gxy * gxy;
      if (det < 1e-6 * count * count) { failed = true; break; }
      let vx = 0, vy = 0;
      for (let it = 0; it < iterations; it++) {
        let bx = 0, by = 0; k = 0;
        for (let dy = -window; dy <= window; dy++) for (let dx = -window; dx <= window; dx++, k++) {
          const diff = T[k] - sampleAt(N.data, N.width, N.height, px + dx + gx + vx, py + dy + gy + vy);
          bx += diff * IX[k]; by += diff * IY[k];
        }
        const ex = (gyy * bx - gxy * by) / det, ey = (gxx * by - gxy * bx) / det;
        vx += ex; vy += ey;
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) { failed = true; break; }
        if (ex * ex + ey * ey < epsilon * epsilon) break;
      }
      if (failed) break;
      if (l > 0) { gx = 2 * (gx + vx); gy = 2 * (gy + vy); } else { gx += vx; gy += vy; }
    }
    const point: Point = [p[0] + gx, p[1] + gy];
    const L0 = next[0];
    if (failed || point[0] < window || point[1] < window || point[0] > L0.width - 1 - window || point[1] > L0.height - 1 - window) return { point, ok: false, residual: Infinity };
    let residual = 0;
    const P0 = prev[0];
    for (let dy = -window; dy <= window; dy++) for (let dx = -window; dx <= window; dx++) {
      residual += Math.abs(sampleAt(P0.data, P0.width, P0.height, p[0] + dx, p[1] + dy) - sampleAt(L0.data, L0.width, L0.height, point[0] + dx, point[1] + dy));
    }
    residual /= count;
    return { point, ok: residual <= maxResidual, residual };
  });
}

/**
 * Lucas–Kanade forward, then back from where each point landed: a point
 * whose round trip misses its start by more than `fbMax` px is dropped (an
 * occluder edge, a repeated pattern, a patch that slid).
 */
export function trackForwardBackward(prev: Level[], next: Level[], points: Point[], guesses?: Point[], { fbMax = 0.7, ...lk }: LkOptions & { fbMax?: number } = {}): { to: Point[]; ok: boolean[]; fb: number[] } {
  const forward = lkTrack(prev, next, points, guesses, lk);
  const backward = lkTrack(next, prev, forward.map((f) => f.point), points, lk);
  const fb = points.map((p, i) => (forward[i].ok && backward[i].ok ? Math.hypot(backward[i].point[0] - p[0], backward[i].point[1] - p[1]) : Infinity));
  return { to: forward.map((f) => f.point), ok: fb.map((e) => e <= fbMax), fb };
}

// ---------------------------------------------------------------- model selection

export type ModelOptions = {
  tolerance?: number; minInliers?: number; seed?: number;
  maxScaleStep?: number; maxRotationStep?: number; maxShearStep?: number; maxAspectStep?: number;
  /** Minor-axis spread of the agreeing points, as a fraction of √(quad area), each model needs. */
  minSpread?: Partial<Record<PlaneModel, number>>;
};
export type ModelSelection =
  | { ok: true; model: PlaneModel; h: number[]; inliers: number[]; error: number }
  | { ok: false; reason: "too-few-features" | "degenerate-motion"; detail: string };

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function percentile(values: number[], q: number): number {
  if (!values.length) return Infinity;
  const s = [...values].sort((a, b) => a - b);
  const at = (s.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}

function residuals(h: number[], from: Point[], to: Point[]): number[] {
  return from.map((p, i) => { const [u, v] = applyHomography(h, p[0], p[1]); return Math.hypot(u - to[i][0], v - to[i][1]); });
}

/** The smaller principal standard deviation of the points: near zero when they lie along a line or in a clump. */
export function minorSpread(points: Point[]): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n, my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of points) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  sxx /= n; syy /= n; sxy /= n;
  return Math.sqrt(Math.max(0, (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy)));
}

function robust(model: PlaneModel, from: Point[], to: Point[], tolerance: number, seed: number): { h: number[]; inliers: number[]; error: number } | null {
  const fit = robustFit(model, from, to, { tolerance, seed, rounds: 96 });
  if (!fit || fit.h.some((v) => !Number.isFinite(v))) return null;
  const res = residuals(fit.h, from, to);
  const inliers = res.flatMap((e, i) => (e <= tolerance ? [i] : []));
  return { h: fit.h, inliers, error: median(inliers.map((i) => res[i])) };
}

/**
 * The simplest plane motion the tracked points support between two frames.
 * Similarity, affine (n ≥ 10) and homography (n ≥ 16) are each fitted on
 * their own, and each is judged on its own inliers: enough of them, spread
 * enough for that model, and a step inside the degeneracy gates (per-step
 * scale, rotation, shear and aspect change; the moved quad a sane convex
 * plane). Of the candidates that pass, a richer one replaces a simpler one
 * only when it explains clearly more points, or the same points clearly
 * better. A similarity that fails (a 4% stretch leaves only a line of points
 * agreeing with it) does not block an affine that fits everything.
 *
 * If a richer model explains the points clearly better than the chosen one
 * but is refused by the gates, the step is refused as degenerate rather than
 * falling back to a simpler model that only explains a subset; and a model
 * explaining under half the followed points is refused as a guess.
 */
export function selectModel(from: Point[], to: Point[], quad: Quad, options: ModelOptions = {}): ModelSelection {
  const { tolerance = 1, minInliers = 6, seed = 7, maxScaleStep = 0.15, maxRotationStep = 6, maxShearStep = 4, maxAspectStep = 0.1 } = options;
  const spread = { similarity: 0.06, affine: 0.1, homography: 0.14, ...options.minSpread };
  const n = Math.min(from.length, to.length);
  if (n < minInliers) return { ok: false, reason: "too-few-features", detail: `only ${n} points followed` };
  const size = Math.sqrt(Math.abs(signedArea(quad))) || 1;
  const centre = quadCentre(quad);
  const spreadOk = (model: PlaneModel, inliers: number[]) => minorSpread(inliers.map((i) => from[i])) >= spread[model] * size;
  const shapeOk = (h: number[]) => {
    const s = localShape(h, centre);
    return Math.abs(Math.log(s.scale)) <= Math.log(1 + maxScaleStep) && Math.abs(s.rotation) <= maxRotationStep && Math.abs(s.shear) <= maxShearStep && Math.abs(Math.log(s.aspect)) <= Math.log(1 + maxAspectStep) && quadIsSane(mapQuad(h, quad));
  };
  // A richer model must explain clearly more points, or the same points clearly better (by a margin that is not noise).
  type Fit = { model: PlaneModel; h: number[]; inliers: number[]; error: number };
  const better = (a: Fit, b: Fit) =>
    a.inliers.length >= b.inliers.length + Math.max(2, Math.ceil(0.1 * n)) || (a.inliers.length >= b.inliers.length && a.error < 0.7 * b.error && b.error - a.error > 0.1 * tolerance);
  const models: PlaneModel[] = ["similarity", ...(n >= 10 ? ["affine" as const] : []), ...(n >= 16 ? ["homography" as const] : [])];
  const fits: (Fit & { status: "ok" | "few" | "spread" | "shape" })[] = [];
  for (const model of models) {
    const fit = robust(model, from.slice(0, n), to.slice(0, n), tolerance, seed);
    if (!fit) continue;
    const status = fit.inliers.length < minInliers ? "few" : !spreadOk(model, fit.inliers) ? "spread" : !shapeOk(fit.h) ? "shape" : "ok";
    fits.push({ model, ...fit, status });
  }
  let best: Fit | null = null;
  for (const fit of fits) if (fit.status === "ok" && (!best || better(fit, best))) best = fit;
  // A candidate turned away only by the shape gates that would have beaten the choice: the motion is degenerate.
  const refused = fits.find((f) => f.status === "shape" && (!best || better(f, best)));
  if (refused) return { ok: false, reason: "degenerate-motion", detail: "the points move in a way only a sheared, stretched or collapsed plane explains" };
  if (!best) {
    if (fits.some((f) => f.status === "spread")) return { ok: false, reason: "degenerate-motion", detail: "the points that agree are bunched in one place or along one line" };
    const most = Math.max(0, ...fits.map((f) => f.inliers.length));
    return { ok: false, reason: "too-few-features", detail: `only ${most} of ${n} points agree on one motion` };
  }
  // Most of the followed points must move with the plane; a model that explains a minority is a guess.
  if (best.inliers.length < 0.5 * n) return { ok: false, reason: "too-few-features", detail: `only ${best.inliers.length} of ${n} points agree on one motion` };
  return { ok: true, ...best };
}

// ---------------------------------------------------------------- re-registration

/** `frame` resampled into another frame's coordinates: out(x, y) = frame(h(x, y)). */
export function warpGray(frame: Gray, h: number[], width: number, height: number): Gray {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = h[6] * x + h[7] * y + h[8] || 1e-9;
      out[y * width + x] = sampleAt(frame.data, frame.width, frame.height, (h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w);
    }
  }
  return { data: out, width, height };
}

export type Reference = { levels: Level[]; points: Point[]; quad: Quad };
export type Registration = { ok: true; h: number[]; inliers: Point[]; coverage: number; error: number } | { ok: false; reason: string };

/**
 * Drift correction: warp `frame` back into the reference frame by the
 * predicted plane `predicted` (reference → frame), track the reference
 * features into that warp (a small residual motion, since the warp already
 * undid most of it), fit the residual and compose. Fails, leaving the caller's
 * prediction alone, when too few reference features are visible or agree.
 */
export function register(ref: Reference, frame: Gray, predicted: number[], options: { window?: number; levels?: number; fbMax?: number; tolerance?: number; minInliers?: number; maxResidual?: number } = {}): Registration {
  const { window = 5, levels = 3, fbMax = 0.7, tolerance = 1, minInliers = 6, maxResidual = 20 } = options;
  const { width, height } = ref.levels[0];
  const edge = window + 1;
  const visible = ref.points.filter((p) => { const [x, y] = applyHomography(predicted, p[0], p[1]); return x >= edge && y >= edge && x < frame.width - edge && y < frame.height - edge; });
  if (visible.length < minInliers) return { ok: false, reason: "surface out of frame" };
  const warped = buildPyramid(warpGray(frame, predicted, width, height), levels);
  const tracked = trackForwardBackward(ref.levels, warped, visible, undefined, { window, fbMax, maxResidual });
  const keep = visible.flatMap((_, i) => (tracked.ok[i] ? [i] : []));
  const sel = selectModel(keep.map((i) => visible[i]), keep.map((i) => tracked.to[i]), ref.quad, { tolerance, minInliers, maxScaleStep: 0.12, maxRotationStep: 5, maxShearStep: 5, maxAspectStep: 0.12 });
  if (!sel.ok) return { ok: false, reason: sel.detail };
  const h = mulHomography(predicted, sel.h);
  const inliers = sel.inliers.map((i) => applyHomography(h, visible[keep[i]][0], visible[keep[i]][1]) as Point);
  const { coverage } = quadCoverage(inliers, mapQuad(h, ref.quad), frame.width, frame.height);
  if (coverage < 0.3) return { ok: false, reason: "too little of the surface matched the reference" };
  return { ok: true, h, inliers, coverage, error: sel.error };
}

// ---------------------------------------------------------------- the tracker

export type TrackFailure = "too-few-features" | "plane-lost" | "degenerate-motion";

export type TrackFrame = {
  index: number;
  /** The plane's corners in this frame, pixels, in the anchor quad's corner order. */
  quad: Quad;
  /** 0–1: attachment × visibility. 0 on held and lost frames. Above 0.5 means "this is on the surface". */
  confidence: number;
  /** 0–1: how well agreeing features cover the quad and how small the reprojection error is. */
  attachment: number;
  /** Share of the quad's visible cells holding an agreeing feature. */
  coverage: number;
  /** Reprojection error (75th percentile) of every point that survived the forward–backward check, not only the inliers, px. */
  error: number;
  /** Rough corner uncertainty, px; null when the frame was not measured (held, lost). */
  uncertaintyPx: number | null;
  inliers: number;
  model: PlaneModel | null;
  /** The step was refused and the plane held where it was. */
  held: boolean;
  /** The plane was lost before this frame; the quad is the last one measured. */
  lost: boolean;
  /** Corrected against the reference frame on this step. */
  registered: boolean;
  /** An author-placed quad. */
  anchor: boolean;
};

export type TrackStats = { points: number; meanInliers: number; held: number; steps: number; corrections: number };

export type TrackResult =
  | { ok: true; frames: TrackFrame[]; lostAt: number | null; lostReason: TrackFailure | null; message: string | null; stats: TrackStats }
  | { ok: false; reason: TrackFailure; frame: number; message: string };

export type TrackOptions = {
  /** Pyramid levels (2 or 3). */
  levels?: number;
  /** Lucas–Kanade half-window, px. */
  window?: number;
  /** How far inside the quad's edges features must sit, px (default: window + 1). */
  margin?: number;
  maxPoints?: number;
  /** Fewest features inside the surface worth tracking. */
  minPoints?: number;
  /** Corner strength floor (Shi–Tomasi, grey levels²). */
  minCorner?: number;
  fbMax?: number;
  /** RANSAC inlier distance, px (default: 0.3% of the frame width, at least 0.75). */
  tolerance?: number;
  /** Re-register to the reference frame every this many steps. */
  refreshEvery?: number;
  /** Consecutive refused steps before the plane counts as lost. */
  maxMisses?: number;
  maxResidual?: number;
  /** A wider area, px, the author chose to take features from instead of the quad itself (opt-in; the default is the quad). */
  support?: Quad;
  onProgress?(fraction: number): void;
};

/** The RANSAC inlier distance for a frame width, px: 0.3% of the width, at least 0.75 (1.08 px at the editor's 360). */
export function defaultTolerance(width: number): number {
  return Math.max(0.75, width * 0.003);
}

type Resolved = Required<Omit<TrackOptions, "support" | "onProgress" | "margin" | "tolerance">> & { margin: number; tolerance: number; support?: Quad };

function resolve(options: TrackOptions, width: number): Resolved {
  const window = options.window ?? 5;
  return {
    levels: options.levels ?? 3, window, margin: options.margin ?? window + 1, maxPoints: options.maxPoints ?? 80, minPoints: options.minPoints ?? 8,
    minCorner: options.minCorner ?? 8, fbMax: options.fbMax ?? 0.7, tolerance: options.tolerance ?? defaultTolerance(width),
    refreshEvery: options.refreshEvery ?? 4, maxMisses: options.maxMisses ?? 3, maxResidual: options.maxResidual ?? 20, support: options.support,
  };
}

const MESSAGES: Record<TrackFailure, (detail: string) => string> = {
  "too-few-features": (d) => `Could not follow this surface: too few points of detail inside it (${d}). Pick a surface with some texture or edges inside its corners, or widen the area to track.`,
  "plane-lost": (d) => `Could not follow this surface: it was lost ${d} (covered, out of frame, or changed too much).`,
  "degenerate-motion": (d) => `Could not follow this surface: the motion ${d} would shear or collapse the plane.`,
};

/** Score one measured frame from where its agreeing features are and how well all tracked points fit. */
function score(points: Point[], quad: Quad, error: number, inliers: number, width: number, height: number, tolerance: number) {
  const { coverage, visible } = quadCoverage(points, quad, width, height);
  const attachment = Math.min(1, coverage / 0.6) * Math.exp(-((error / tolerance) ** 2));
  const confidence = attachment * Math.min(1, visible / 0.4);
  const uncertaintyPx = (Math.max(error, 0.05) * Math.sqrt(8 / Math.max(1, inliers))) / Math.max(0.15, coverage);
  return { coverage, attachment, confidence, uncertaintyPx };
}

const round = (v: number, d: number) => Number(v.toFixed(d));

/** One run from an anchor in one direction, up to and including `end`. */
type RunResult = { frames: Map<number, TrackFrame>; lostAt: number | null; reacquiredAt?: number | null; lostReason: TrackFailure | null; detail: string; stats: TrackStats; failure?: { reason: TrackFailure; detail: string } };

/** Yields after every frame step (the progress so far), so a caller can hand the thread back between steps. */
function* runFrom(frames: Gray[], start: number, end: number, quad0: Quad, o: Resolved, pyramids: (i: number) => Level[], progress: () => number): Generator<number, RunResult, void> {
  const dir = end >= start ? 1 : -1;
  const { width, height } = frames[start];
  const refLevels = pyramids(start);
  const support = o.support ?? quad0;
  const margin = Math.min(o.margin, Math.sqrt(Math.abs(signedArea(quad0))) * 0.2);
  const refPoints = supportPoints(refLevels[0], support, { margin, maxPoints: o.maxPoints, window: o.window, minCorner: o.minCorner });
  const stats: TrackStats = { points: refPoints.length, meanInliers: 0, held: 0, steps: 0, corrections: 0 };
  const out = new Map<number, TrackFrame>();
  const startCov = quadCoverage(refPoints, quad0, width, height);
  if (refPoints.length < o.minPoints || startCov.coverage < 0.25) {
    return { frames: out, lostAt: null, lostReason: null, detail: "", stats, failure: { reason: "too-few-features", detail: `${refPoints.length} found, covering ${Math.round(startCov.coverage * 100)}% of it; need ${o.minPoints} spread over a quarter of it` } };
  }
  const ref: Reference = { levels: refLevels, points: refPoints, quad: o.support ?? quad0 };
  out.set(start, { index: start, quad: quad0, confidence: 1, attachment: 1, coverage: startCov.coverage, error: 0, uncertaintyPx: 0, inliers: refPoints.length, model: null, held: false, lost: false, registered: false, anchor: true });
  let H = IDENTITY; // reference → current frame
  let velocity: number[] | null = null; // last one-frame step
  let anchorIdx = start, anchorPts = refPoints;
  let misses = 0, inlierSum = 0, measured = 0;
  // `lostAt` is set while the plane is lost (cleared if it is found again); `firstLost` remembers the first loss.
  let lostAt: number | null = null, firstLost: number | null = null, lostReason: TrackFailure | null = null, detail = "";
  const lk = { window: o.window, fbMax: o.fbMax, maxResidual: o.maxResidual };
  const sinceStart = (k: number) => (k - start) * dir;
  let reacquiredAt: number | null = null;
  const regOptions = { window: o.window, levels: o.levels, fbMax: o.fbMax, tolerance: o.tolerance, minInliers: Math.max(6, Math.ceil(o.minPoints * 0.75)), maxResidual: o.maxResidual };
  const saneFromRef = (h: number[]) => { const q = mapQuad(h, quad0), stretch = quadAspect(q) / quadAspect(quad0); return quadIsSane(q) && stretch >= 0.5 && stretch <= 2; };
  const freshPoints = (k: number, quad: Quad, keep: Point[]) => {
    const edge = o.window + 1;
    const region = o.support ? mapQuad(H, o.support) : quad;
    const points = keep.filter((p) => p[0] >= edge && p[1] >= edge && p[0] < width - edge && p[1] < height - edge && insideQuad(region, p[0], p[1], 0));
    if (points.length < Math.max(o.minPoints * 2, refPoints.length * 0.5) || quadCoverage(points, quad, width, height).coverage < 0.5) {
      const fresh = supportPoints(pyramids(k)[0], region, { margin, maxPoints: o.maxPoints, window: o.window, minCorner: o.minCorner });
      for (const f of fresh) if (!points.some((p) => Math.hypot(p[0] - f[0], p[1] - f[1]) < o.window)) points.push(f);
    }
    return points;
  };
  for (let k = start + dir; dir > 0 ? k <= end : k >= end; k += dir) {
    stats.steps++;
    if (lostAt !== null) {
      // Lost: look for the surface again against the reference (an occluder passed, the camera came back).
      const found = register(ref, frames[k], H, regOptions);
      if (found.ok && saneFromRef(found.h)) {
        H = found.h; velocity = null; misses = 0; stats.corrections++;
        reacquiredAt ??= k;
        const quad = mapQuad(H, quad0);
        const s = score(found.inliers, quad, found.error, found.inliers.length, width, height, o.tolerance);
        inlierSum += found.inliers.length; measured++;
        out.set(k, { index: k, quad, confidence: s.confidence, attachment: s.attachment, coverage: s.coverage, error: found.error, uncertaintyPx: s.uncertaintyPx, inliers: found.inliers.length, model: "homography", held: false, lost: false, registered: true, anchor: false });
        anchorIdx = k; anchorPts = freshPoints(k, quad, found.inliers);
        lostAt = null;
      } else {
        stats.held++;
        out.set(k, { index: k, quad: mapQuad(H, quad0), confidence: 0, attachment: 0, coverage: 0, error: Infinity, uncertaintyPx: null, inliers: 0, model: null, held: true, lost: true, registered: false, anchor: false });
      }
      yield progress();
      continue;
    }
    const gap = Math.abs(k - anchorIdx);
    let guessH: number[] | null = null;
    if (velocity) { guessH = velocity; for (let g = 1; g < gap; g++) guessH = mulHomography(velocity, guessH); }
    const guesses = guessH ? anchorPts.map((p) => applyHomography(guessH!, p[0], p[1]) as Point) : undefined;
    const current = mapQuad(H, quad0);
    const tracked = trackForwardBackward(pyramids(anchorIdx), pyramids(k), anchorPts, guesses, lk);
    const keep = anchorPts.flatMap((_, i) => (tracked.ok[i] ? [i] : []));
    const from = keep.map((i) => anchorPts[i]), to = keep.map((i) => tracked.to[i]);
    const sel = selectModel(from, to, current, { tolerance: o.tolerance, minInliers: Math.max(6, Math.ceil(o.minPoints * 0.75)) });
    let candidate: number[] | null = null;
    let failure: { reason: TrackFailure; detail: string } | null = null;
    if (sel.ok) {
      candidate = mulHomography(sel.h, H);
      const q = mapQuad(candidate, quad0);
      const stretch = quadAspect(q) / quadAspect(quad0);
      if (!quadIsSane(q) || stretch < 0.5 || stretch > 2) { candidate = null; failure = { reason: "degenerate-motion", detail: "the plane has sheared or stretched too far from the one placed" }; }
    } else failure = { reason: sel.reason === "too-few-features" ? "plane-lost" : sel.reason, detail: sel.detail };
    let registered: Registration | null = null;
    if (!candidate || sinceStart(k) % o.refreshEvery === 0) {
      const predicted = candidate ?? (guessH ? mulHomography(guessH, H) : H);
      registered = register(ref, frames[k], predicted, regOptions);
      if (registered.ok) {
        if (saneFromRef(registered.h)) { candidate = registered.h; stats.corrections++; } else registered = { ok: false, reason: "re-registered plane is not sane" };
      }
    }
    if (!candidate) {
      misses++; stats.held++;
      if (failure) { lostReason = failure.reason; detail = failure.detail; }
      out.set(k, { index: k, quad: current, confidence: 0, attachment: 0, coverage: 0, error: Infinity, uncertaintyPx: null, inliers: 0, model: null, held: true, lost: false, registered: false, anchor: false });
      if (misses >= o.maxMisses) {
        // Lost from the first refused step: those frames were held, now they are lost too.
        const first = k - (misses - 1) * dir;
        firstLost ??= first;
        lostAt = first;
        for (let j = first; j !== k + dir; j += dir) out.set(j, { ...out.get(j)!, lost: true });
      }
      yield progress();
      continue;
    }
    const nextQuad = mapQuad(candidate, quad0);
    if (gap === 1) velocity = mulHomography(candidate, invertHomography(H) ?? IDENTITY);
    else velocity = null;
    H = candidate; misses = 0;
    // Evidence for this frame: agreeing features (step inliers, or reference matches when re-registered).
    const stepInliers = sel.ok ? sel.inliers.map((i) => to[i]) : [];
    const evidence = registered?.ok ? registered.inliers : stepInliers;
    const error = sel.ok ? percentile(residuals(sel.h, from, to), 0.75) : (registered as { error: number }).error;
    const s = score(evidence, nextQuad, Number.isFinite(error) ? error : o.tolerance * 2, evidence.length, width, height, o.tolerance);
    inlierSum += evidence.length; measured++;
    out.set(k, { index: k, quad: nextQuad, confidence: s.confidence, attachment: s.attachment, coverage: s.coverage, error: Number.isFinite(error) ? error : o.tolerance * 2, uncertaintyPx: s.uncertaintyPx, inliers: evidence.length, model: sel.ok ? sel.model : "homography", held: false, lost: false, registered: !!registered?.ok, anchor: false });
    // Carry the agreeing points on; top up from the current frame, inside the current quad only.
    anchorIdx = k; anchorPts = freshPoints(k, nextQuad, sel.ok ? stepInliers : (registered as { inliers: Point[] }).inliers);
    yield progress();
  }
  stats.meanInliers = measured ? inlierSum / measured : 0;
  return { frames: out, lostAt: firstLost, reacquiredAt, lostReason: firstLost !== null ? lostReason ?? "plane-lost" : null, detail, stats };
}

/**
 * Track a surface through `frames` from one or more author-placed quads
 * (`anchors`, pixels, the same corner order each). With one anchor the plane
 * is followed forward and backward from it; with several, each frame between
 * two anchors blends the run forward from the earlier with the run backward
 * from the later (by distance, weighted by confidence), so a correction at
 * frame k pulls the track onto the surface around k without disturbing
 * frames that were already right.
 */
export function trackSurface(frames: Gray[], anchors: { index: number; quad: Quad }[], options: TrackOptions = {}): TrackResult {
  const steps = trackSteps(frames, anchors, options);
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) return step.value;
    options.onProgress?.(step.value);
  }
}

/**
 * `trackSurface` that hands the thread back every `yieldEvery` frame steps
 * (by awaiting `yieldTo`, a macrotask by default), so the editor can paint
 * progress and stay responsive. The arithmetic and the result are identical
 * to `trackSurface`; only the scheduling differs.
 */
export async function trackSurfaceAsync(frames: Gray[], anchors: { index: number; quad: Quad }[], options: TrackOptions & { yieldEvery?: number; yieldTo?: () => Promise<void> } = {}): Promise<TrackResult> {
  const { yieldEvery = 2, yieldTo = () => new Promise<void>((resolve) => setTimeout(resolve, 0)) } = options;
  const steps = trackSteps(frames, anchors, options);
  let count = 0;
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) return step.value;
    options.onProgress?.(step.value);
    if (++count % Math.max(1, yieldEvery) === 0) await yieldTo();
  }
}

/** The tracker as a generator: yields progress (0-1) after every frame step and returns the result. */
export function* trackSteps(frames: Gray[], anchors: { index: number; quad: Quad }[], options: TrackOptions = {}): Generator<number, TrackResult, void> {
  if (!frames.length || !anchors.length) return { ok: false, reason: "too-few-features", frame: 0, message: MESSAGES["too-few-features"]("no frames or no surface") };
  const o = resolve(options, frames[0].width);
  const sorted = [...new Map(anchors.filter((a) => a.index >= 0 && a.index < frames.length).map((a) => [a.index, a])).values()].sort((a, b) => a.index - b.index);
  if (!sorted.length) return { ok: false, reason: "too-few-features", frame: 0, message: MESSAGES["too-few-features"]("no surface inside the frames") };
  const cache = new Map<number, Level[]>();
  const pyramids = (i: number) => {
    let p = cache.get(i);
    if (!p) {
      p = buildPyramid(frames[i], o.levels);
      cache.set(i, p);
      if (cache.size > 4) cache.delete(cache.keys().next().value!);
    }
    return p;
  };
  let done = 0;
  const totalSteps = Math.max(1, frames.length - 1 + sorted.slice(1).reduce((s, a, i) => s + a.index - sorted[i].index, 0));
  const progress = () => Math.min(1, ++done / totalSteps);
  type Run = RunResult;
  const forward: Run[] = [], backward: Run[] = [];
  for (let a = 0; a < sorted.length; a++) {
    const { index, quad } = sorted[a];
    const nextAnchor = a + 1 < sorted.length ? sorted[a + 1].index : frames.length - 1;
    const prevAnchor = a > 0 ? sorted[a - 1].index : 0;
    const f = yield* runFrom(frames, index, nextAnchor, quad, o, pyramids, progress);
    if (f.failure) return { ok: false, reason: f.failure.reason, frame: index, message: MESSAGES[f.failure.reason](f.failure.detail) };
    const b = index > prevAnchor ? yield* runFrom(frames, index, prevAnchor, quad, o, pyramids, progress) : null;
    forward.push(f);
    backward.push(b ?? { frames: new Map(), lostAt: null, lostReason: null, detail: "", stats: { points: 0, meanInliers: 0, held: 0, steps: 0, corrections: 0 } });
  }
  const result: TrackFrame[] = [];
  for (let k = 0; k < frames.length; k++) {
    const anchor = sorted.findIndex((s) => s.index === k);
    if (anchor >= 0) { result.push(forward[anchor].frames.get(k)!); continue; }
    // The anchors either side of k, and the runs that reach it.
    const after = sorted.findIndex((s) => s.index > k);
    const before = after === -1 ? sorted.length - 1 : after - 1;
    const fromBefore = before >= 0 ? forward[before].frames.get(k) : undefined;
    const fromAfter = after >= 0 ? backward[after].frames.get(k) : undefined;
    const live = [fromBefore, fromAfter].filter((f): f is TrackFrame => !!f && !f.lost);
    if (!live.length) {
      const held = fromBefore ?? fromAfter;
      result.push(held ? { ...held, index: k } : { ...forward[0].frames.get(sorted[0].index)!, index: k, confidence: 0, attachment: 0, held: true, lost: true, anchor: false, uncertaintyPx: null });
      continue;
    }
    if (live.length === 1) { result.push({ ...live[0], index: k }); continue; }
    const a = sorted[before].index, b = sorted[after].index;
    const w = (k - a) / (b - a);
    const wa = (1 - w) * (fromBefore!.confidence + 1e-3), wb = w * (fromAfter!.confidence + 1e-3);
    const t = wb / (wa + wb);
    const mix = (x: number, y: number) => x + (y - x) * t;
    result.push({
      ...fromBefore!, index: k,
      quad: fromBefore!.quad.map((v, i) => mix(v, fromAfter!.quad[i])) as Quad,
      confidence: mix(fromBefore!.confidence, fromAfter!.confidence), attachment: mix(fromBefore!.attachment, fromAfter!.attachment),
      coverage: mix(fromBefore!.coverage, fromAfter!.coverage), error: mix(fromBefore!.error, fromAfter!.error),
      uncertaintyPx: fromBefore!.uncertaintyPx !== null && fromAfter!.uncertaintyPx !== null ? mix(fromBefore!.uncertaintyPx, fromAfter!.uncertaintyPx) : null,
      held: fromBefore!.held && fromAfter!.held, registered: fromBefore!.registered || fromAfter!.registered,
    });
  }
  const first = sorted[0].index;
  const lostAt = result.find((f) => f.index > first && f.lost)?.index ?? null;
  const runs = [...forward, ...backward];
  const lostRun = runs.find((r) => r.lostAt !== null && r.lostAt === lostAt) ?? runs.find((r) => r.lostAt !== null);
  const measured = result.filter((f) => !f.anchor && !f.lost);
  if (frames.length > 1 && !result.some((f) => !f.anchor && !f.held && !f.lost)) {
    const reason = lostRun?.lostReason ?? "plane-lost";
    const at = lostRun?.lostAt ?? first + 1;
    return { ok: false, reason, frame: at, message: MESSAGES[reason](`at frame ${at}${lostRun?.detail ? ` (${lostRun.detail})` : ""}`) };
  }
  const stats: TrackStats = {
    points: forward[0].stats.points,
    meanInliers: measured.length ? measured.reduce((s, f) => s + f.inliers, 0) / measured.length : 0,
    held: runs.reduce((s, r) => s + r.stats.held, 0), steps: runs.reduce((s, r) => s + r.stats.steps, 0), corrections: runs.reduce((s, r) => s + r.stats.corrections, 0),
  };
  const lostReason = lostAt !== null ? lostRun?.lostReason ?? "plane-lost" : null;
  return {
    ok: true,
    frames: result.map((f) => ({ ...f, confidence: round(f.confidence, 3), attachment: round(f.attachment, 3), coverage: round(f.coverage, 3) })),
    lostAt, lostReason,
    message: lostReason ? `${MESSAGES[lostReason](`at frame ${lostAt}${lostRun?.detail ? ` (${lostRun.detail})` : ""}`)}${lostRun?.reacquiredAt != null ? ` Found it again at frame ${lostRun.reacquiredAt}.` : ""}` : null,
    stats,
  };
}

/**
 * Smooth the measured corners without lag and without lying (ADR 0052):
 * `passes` of a centred 1-2-1 average over each corner, only within runs of
 * measured frames. Held and lost frames are never part of a run, and the end
 * points of a run stay where they were measured. Afterwards each frame's
 * corners may sit at most max(k × `uncertaintyPx`, `floorPx`) from the
 * measurement: the floor (the tracker's inlier tolerance) lets ordinary
 * sub-pixel shimmer be smoothed away, since `uncertaintyPx` underestimates
 * true corner error several times over on the benchmark; the bound still
 * stops smoothing from carrying a frame far off its surface (a measured
 * 10 px jolt moves about 1 px, not 6). Author anchors do not move at all.
 */
export function smoothTrack(frames: TrackFrame[], { passes = 2, k = 5, floorPx = 1 }: { passes?: number; k?: number; floorPx?: number } = {}): TrackFrame[] {
  const out = frames.map((f) => ({ ...f, quad: [...f.quad] as Quad }));
  const measured = (f: TrackFrame) => !f.held && !f.lost;
  for (let i = 0; i < frames.length;) {
    if (!measured(frames[i])) { i++; continue; }
    let j = i;
    while (j < frames.length && measured(frames[j])) j++;
    if (j - i >= 3) {
      const quads = frames.slice(i, j).map((f) => [...f.quad]);
      for (let pass = 0; pass < passes; pass++) {
        const prior = quads.map((q) => [...q]);
        for (let m = 1; m < quads.length - 1; m++) for (let c = 0; c < 8; c++) quads[m][c] = (prior[m - 1][c] + 2 * prior[m][c] + prior[m + 1][c]) / 4;
      }
      quads.forEach((q, m) => {
        const raw = frames[i + m];
        const bound = raw.anchor ? 0 : Math.max(k * Math.max(0, raw.uncertaintyPx ?? 0), floorPx);
        out[i + m].quad = q.map((v, c) => raw.quad[c] + Math.max(-bound, Math.min(bound, v - raw.quad[c]))) as Quad;
      });
    }
    i = j;
  }
  return out;
}

export type TrackPathPoint = { t: number; x: number; y: number; s: number; r: number; q: number[]; o?: number };

/**
 * The keyframes the editor saves for a track (ADR 0039 path format, ADR
 * 0052 rules), from tracked frames sampled at source `times` (ms):
 *
 * - `t` runs over the pin's interval (`pin.fromMs` to `pin.toMs`), the same
 *   interval `pinnedProgress` plays it over, with a held end point at t = 1
 *   when the last sample falls short;
 * - lost frames are hidden (o = 0) and carry the corners of the nearest
 *   measured frame on their side of the gap (the last one before the loss
 *   for the first half, the re-found one after, and always the next measured
 *   frame's corners directly before it), so nothing stale is drawn
 *   while the title fades out or back in; measured frames are fully opaque;
 * - held (refused) frames inside a track take corners interpolated between
 *   the measured frames either side rather than repeating stale ones;
 * - `confidence[i]` is the tracker's confidence for keyframe i (0 when lost).
 */
export function trackPath(frames: TrackFrame[], times: number[], pin: { fromMs: number; toMs: number }, text: { x: number; y: number }, size: { width: number; height: number }): { path: TrackPathPoint[]; confidence: number[] } {
  const { width, height } = size;
  const span = Math.max(1, pin.toMs - pin.fromMs);
  const tOf = (i: number) => Math.max(0, Math.min(1, (times[i] - pin.fromMs) / span));
  const live = frames.flatMap((f, i) => (f.held || f.lost ? [] : [i]));
  const quads = frames.map((f, i) => {
    if (!f.held && !f.lost) return f.quad;
    let before: number | undefined, after: number | undefined;
    for (const j of live) { if (j < i) before = j; else if (j > i && after === undefined) after = j; }
    if (f.lost) {
      if (before === undefined) return after !== undefined ? frames[after].quad : f.quad;
      if (after === undefined) return frames[before].quad;
      // The keyframe just before a measured one carries that frame's corners, so the fade in never slides
      // (a one-frame gap between runs from different anchors would otherwise take the earlier corners).
      if (after === i + 1) return frames[after].quad;
      return i - before <= after - i ? frames[before].quad : frames[after].quad;
    }
    if (before === undefined || after === undefined) return frames[before ?? after ?? i].quad;
    const w = (i - before) / (after - before);
    return frames[before].quad.map((v, c) => v + (frames[after!].quad[c] - v) * w) as Quad;
  });
  const base = quads[0];
  const baseDistance = Math.hypot(base[2] - base[0], base[3] - base[1]) || 1;
  const baseAngle = Math.atan2(base[3] - base[1], base[2] - base[0]);
  const points = frames.map((frame, i) => {
    const [tlx, tly, trx, try_, brx, bry, blx, bly] = quads[i];
    const mid = { x: (tlx + trx + brx + blx) / 4, y: (tly + try_ + bry + bly) / 4 };
    const point: TrackPathPoint = {
      t: Number(tOf(i).toFixed(4)),
      x: Number(Math.max(-0.5, Math.min(0.5, mid.x / width - text.x)).toFixed(4)),
      y: Number(Math.max(-0.5, Math.min(0.5, mid.y / height - text.y)).toFixed(4)),
      s: Number(Math.max(0.2, Math.min(5, Math.hypot(trx - tlx, try_ - tly) / baseDistance)).toFixed(3)),
      r: Number(Math.max(-180, Math.min(180, ((Math.atan2(try_ - tly, trx - tlx) - baseAngle) * 180) / Math.PI)).toFixed(2)),
      q: quads[i].map((v, k) => Number(Math.max(-2, Math.min(3, k % 2 === 0 ? v / width : v / height)).toFixed(4))),
      ...(frame.lost ? { o: 0 } : {}),
    };
    return { point, c: frame.lost ? 0 : frame.confidence };
  });
  // Strictly increasing t from 0, ending at 1 (the last sample held to the end of the pin).
  const kept = points.filter((p, i) => i === 0 || p.point.t > points[i - 1].point.t);
  kept[0] = { ...kept[0], point: { ...kept[0].point, t: 0 } };
  const last = kept[kept.length - 1];
  if (last.point.t < 1) kept.push({ point: { ...last.point, t: 1 }, c: last.c });
  return { path: kept.map((k) => k.point), confidence: kept.map((k) => k.c) };
}
