/**
 * Measured motion from small grayscale frames, so the director gets facts
 * about camera direction and cuts rather than reading them off stills:
 * a presenter who rises before she falls, a facade that dissolves into an
 * interior, a take that flips from looking down to looking up.
 *
 * Frames are Float32Array luminance (0–255), row-major, `width × height`.
 * The browser makes them (apps/web/components/editor/frame-analysis.ts); this
 * module only does arithmetic, so it is tested without a DOM.
 */

export type Gray = { data: Float32Array; width: number; height: number };
export type MotionSample = {
  /** Source time of the earlier frame, ms. */
  t: number;
  /** Source time of the later frame, ms. */
  t2: number;
  /** Dominant image shift between the two, pixels at the analysed size; dy > 0 is content moving down the frame. */
  dx: number;
  dy: number;
  /** Mean squared difference after that shift, 0–1 (1 = every pixel from black to white). 0.06 and up is a different picture. */
  change: number;
};

/** Mean squared difference between `a` and `b` shifted by (dx, dy), over the overlap, normalised to 0–1. */
export function shiftedDifference(a: Gray, b: Gray, dx: number, dy: number): number {
  const { width, height } = a;
  let sum = 0, count = 0;
  for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y++) {
    const rowA = (y - dy) * width, rowB = y * width;
    for (let x = Math.max(0, dx); x < Math.min(width, width + dx); x++) {
      const d = a.data[rowA + x - dx] - b.data[rowB + x];
      sum += d * d; count++;
    }
  }
  return count ? sum / count / 65025 : 1;
}

/** The integer shift within ±range that best maps `a` onto `b`. */
export function bestShift(a: Gray, b: Gray, range = 6): { dx: number; dy: number; change: number } {
  let best = { dx: 0, dy: 0, change: shiftedDifference(a, b, 0, 0) };
  for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
    if (dx === 0 && dy === 0) continue;
    const change = shiftedDifference(a, b, dx, dy);
    if (change < best.change) best = { dx, dy, change };
  }
  return best;
}

/** Motion between each consecutive pair of sampled frames. */
export function motionProfile(frames: { t: number; gray: Gray }[], range = 6): MotionSample[] {
  const out: MotionSample[] = [];
  for (let i = 1; i < frames.length; i++) {
    const shift = bestShift(frames[i - 1].gray, frames[i].gray, range);
    out.push({ t: frames[i - 1].t, t2: frames[i].t, ...shift });
  }
  return out;
}

export type MotionFlag = { atMs: number; what: "vertical reversal" | "horizontal reversal" | "frame change" };

/**
 * What a reviewer needs to know from the profile: where the dominant
 * vertical or horizontal motion reverses, and where the picture changes
 * abruptly (a cut, a morph, a dissolve). Small shifts under `deadband` are
 * treated as still so noise does not count as a reversal.
 */
export function motionFlags(samples: MotionSample[], { deadband = 2, changeThreshold = 0.06 }: { deadband?: number; changeThreshold?: number } = {}): MotionFlag[] {
  const flags: MotionFlag[] = [];
  let lastY = 0, lastX = 0;
  for (const sample of samples) {
    if (sample.change >= changeThreshold) flags.push({ atMs: sample.t2, what: "frame change" });
    const y = Math.abs(sample.dy) >= deadband ? Math.sign(sample.dy) : 0;
    const x = Math.abs(sample.dx) >= deadband ? Math.sign(sample.dx) : 0;
    if (y && lastY && y !== lastY) flags.push({ atMs: sample.t, what: "vertical reversal" });
    if (x && lastX && x !== lastX) flags.push({ atMs: sample.t, what: "horizontal reversal" });
    if (y) lastY = y;
    if (x) lastX = x;
  }
  return flags;
}

/** The profile and its flags in words, for the model. */
export function describeMotion(samples: MotionSample[], flags = motionFlags(samples)): string {
  const seconds = (ms: number) => (ms / 1000).toFixed(2);
  const steps = samples.map((s) => `${seconds(s.t)}–${seconds(s.t2)} s dx ${s.dx >= 0 ? "+" : ""}${s.dx} dy ${s.dy >= 0 ? "+" : ""}${s.dy}${s.change >= 0.06 ? ` CHANGE ${s.change.toFixed(2)}` : ""}`);
  const notes = flags.map((f) => `${f.what} at ${seconds(f.atMs)} s`);
  return `${steps.join("; ")}${notes.length ? `. Flags: ${notes.join(", ")}` : ". No reversals or abrupt changes."}`;
}

/** Mean squared difference, 0–1, between a square patch of `a` centred at (ax, ay) and the same-size patch of `b` at (bx, by). */
export function patchDifference(a: Gray, b: Gray, ax: number, ay: number, bx: number, by: number, radius: number): number {
  let sum = 0, count = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const x1 = ax + dx, y1 = ay + dy, x2 = bx + dx, y2 = by + dy;
    if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0 || x1 >= a.width || y1 >= a.height || x2 >= b.width || y2 >= b.height) continue;
    const d = a.data[y1 * a.width + x1] - b.data[y2 * b.width + x2];
    sum += d * d; count++;
  }
  return count ? sum / count / 65025 : 1;
}

/**
 * Where the patch of `prev` centred at (x, y) went in `next`: the integer
 * position within ±range with the smallest difference. `lost` is set when
 * even the best match is a different picture, so a tracker can hold.
 */
export function trackPatch(prev: Gray, next: Gray, x: number, y: number, { radius = 10, range = 12, lostAt = 0.05 }: { radius?: number; range?: number; lostAt?: number } = {}): { x: number; y: number; change: number; lost: boolean } {
  const cx = Math.round(x), cy = Math.round(y);
  const at = (bx: number, by: number) => patchDifference(prev, next, cx, cy, bx, by, radius);
  let best = { x: cx, y: cy, change: at(cx, cy) };
  for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
    if (!dx && !dy) continue;
    const change = at(cx + dx, cy + dy);
    if (change < best.change) best = { x: cx + dx, y: cy + dy, change };
  }
  // Sub-pixel: fit a parabola through the best match and its neighbours on each axis, so a
  // smooth pan does not snap to the analysis grid (one analysis pixel is several output pixels).
  const refine = (minus: number, zero: number, plus: number) => {
    const curve = minus - 2 * zero + plus;
    return curve > 1e-9 ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * curve))) : 0;
  };
  const fx = refine(at(best.x - 1, best.y), best.change, at(best.x + 1, best.y));
  const fy = refine(at(best.x, best.y - 1), best.change, at(best.x, best.y + 1));
  // Keep the caller's fractional position: the match moved the rounded centre, so apply the same displacement.
  return { x: x + (best.x + fx - cx), y: y + (best.y + fy - cy), change: best.change, lost: best.change > lostAt };
}

/**
 * Smooths tracked keyframes without lag: `passes` of a centred 1-2-1 average
 * over x, y, scale and rotation, end points left where they were measured.
 * Picture motion from a handheld or gimbal pan is smooth; the residual
 * jitter is the tracker's, not the shot's.
 */
export function smoothKeyframes<T extends { t: number; x: number; y: number; s?: number; r?: number; q?: number[] }>(points: T[], passes = 2): T[] {
  if (points.length < 3) return points;
  const keys = ["x", "y", "s", "r"] as const;
  const values = points.map(p => ({ x: p.x, y: p.y, s: p.s ?? 1, r: p.r ?? 0 }));
  const quads = points.every(p => p.q) ? points.map(p => [...p.q!]) : null;
  for (let pass = 0; pass < passes; pass++) {
    const before = values.map(v => ({ ...v }));
    for (let i = 1; i < values.length - 1; i++) for (const k of keys) values[i][k] = (before[i - 1][k] + 2 * before[i][k] + before[i + 1][k]) / 4;
    if (quads) {
      const prior = quads.map(q => [...q]);
      for (let i = 1; i < quads.length - 1; i++) for (let k = 0; k < 8; k++) quads[i][k] = (prior[i - 1][k] + 2 * prior[i][k] + prior[i + 1][k]) / 4;
    }
  }
  return points.map((p, i) => ({ ...p, x: Number(values[i].x.toFixed(4)), y: Number(values[i].y.toFixed(4)), ...(p.s !== undefined ? { s: Number(values[i].s.toFixed(3)) } : {}), ...(p.r !== undefined ? { r: Number(values[i].r.toFixed(2)) } : {}), ...(quads ? { q: quads[i].map(v => Number(v.toFixed(4))) } : {}) }));
}

export type Quad = [number, number, number, number, number, number, number, number];

/**
 * The 3×3 projective transform taking the four `src` corners to the four
 * `dst` corners (top-left, top-right, bottom-right, bottom-left), by direct
 * linear transform with h8 = 1. Null when the corners are degenerate.
 */
export function homography(src: Quad, dst: Quad): number[] | null {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i * 2], y = src[i * 2 + 1], u = dst[i * 2], v = dst[i * 2 + 1];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented system.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

/** A CSS matrix3d() applying the homography (row-major h0..h8) to a plane; use with transform-origin 0 0. */
export function matrix3d(h: number[]): string {
  const n = (v: number) => Number(v.toFixed(6));
  return `matrix3d(${n(h[0])}, ${n(h[3])}, 0, ${n(h[6])}, ${n(h[1])}, ${n(h[4])}, 0, ${n(h[7])}, 0, 0, 1, 0, ${n(h[2])}, ${n(h[5])}, 0, ${n(h[8])})`;
}

/**
 * Among candidate frames from the end of one shot, the one most like the
 * first frame of the next. `close` says whether it is a real match (the
 * two pictures differ by less than 2% after alignment).
 */
export function pickMatchingFrame(candidates: { t: number; gray: Gray }[], target: Gray, range = 4): { t: number; change: number; close: boolean } | null {
  let best: { t: number; change: number } | null = null;
  for (const candidate of candidates) {
    const { change } = bestShift(candidate.gray, target, range);
    if (!best || change < best.change) best = { t: candidate.t, change };
  }
  return best ? { ...best, close: best.change < 0.02 } : null;
}

/** Apply a row-major 3×3 homography to a point. */
export function applyHomography(h: number[], x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + h[8] || 1e-9;
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/**
 * The least-squares homography taking each `from[i]` to `to[i]` (four or more
 * pairs), by direct linear transform on normalised coordinates with h8 = 1.
 * Null when fewer than four pairs or the points are degenerate.
 */
export function fitHomography(from: [number, number][], to: [number, number][]): number[] | null {
  const n = Math.min(from.length, to.length);
  if (n < 4) return null;
  // Normalise both sets (centroid at the origin, mean distance √2) so the normal equations are well conditioned.
  const normalise = (pts: [number, number][]) => {
    const cx = pts.reduce((s, p) => s + p[0], 0) / n, cy = pts.reduce((s, p) => s + p[1], 0) / n;
    const mean = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / n || 1;
    const k = Math.SQRT2 / mean;
    return { pts: pts.map(p => [(p[0] - cx) * k, (p[1] - cy) * k] as [number, number]), T: [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1] };
  };
  const a = normalise(from.slice(0, n)), b = normalise(to.slice(0, n));
  // Normal equations AᵀA h = Aᵀb for the 8 unknowns.
  const M = Array.from({ length: 8 }, () => new Array<number>(9).fill(0));
  const add = (row: number[], rhs: number) => { for (let i = 0; i < 8; i++) { for (let j = 0; j < 8; j++) M[i][j] += row[i] * row[j]; M[i][8] += row[i] * rhs; } };
  for (let i = 0; i < n; i++) {
    const [x, y] = a.pts[i], [u, v] = b.pts[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 9; c++) M[r][c] -= f * M[col][c];
    }
  }
  const hn = [...M.map((row, i) => row[8] / row[i]), 1];
  // Denormalise: H = Tb⁻¹ · Hn · Ta.
  const mul = (p: number[], q: number[]) => Array.from({ length: 9 }, (_, i) => { const r = Math.floor(i / 3), c = i % 3; return p[r * 3] * q[c] + p[r * 3 + 1] * q[3 + c] + p[r * 3 + 2] * q[6 + c]; });
  const kb = b.T[0];
  const Tbinv = [1 / kb, 0, -b.T[2] / kb, 0, 1 / kb, -b.T[5] / kb, 0, 0, 1];
  const H = mul(mul(Tbinv, hn), a.T);
  return H.map(v => v / H[8]);
}

/** The homography most of the tracked points agree on (RANSAC then refit); see `robustFit`. */
export function robustHomography(from: [number, number][], to: [number, number][], options: { tolerance?: number; rounds?: number; seed?: number } = {}): { h: number[]; inliers: number } | null {
  return robustFit("homography", from, to, options);
}

export type PlaneModel = "similarity" | "affine" | "homography";

/**
 * Least-squares similarity (scale, rotation, translation; 4 unknowns) from
 * two or more point pairs, as a row-major 3×3. The model a wall title needs
 * through a pan: it cannot shear or collapse.
 */
export function fitSimilarity(from: [number, number][], to: [number, number][]): number[] | null {
  const n = Math.min(from.length, to.length);
  if (n < 2) return null;
  // Normal equations for [a, b, tx, ty] with x' = a x - b y + tx, y' = b x + a y + ty.
  let saa = 0, sx = 0, sy = 0, su = 0, sv = 0, sxu = 0, syv = 0, sxv = 0, syu = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    saa += x * x + y * y; sx += x; sy += y; su += u; sv += v; sxu += x * u; syv += y * v; sxv += x * v; syu += y * u;
  }
  // Solve the 4×4 system by elimination.
  const M = [
    [saa, 0, sx, sy, sxu + syv],
    [0, saa, -sy, sx, sxv - syu],
    [sx, -sy, n, 0, su],
    [sy, sx, 0, n, sv],
  ];
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 5; c++) M[r][c] -= f * M[col][c];
    }
  }
  const [a, b, tx, ty] = M.map((row, i) => row[4] / row[i]);
  return [a, -b, tx, b, a, ty, 0, 0, 1];
}

/** Least-squares affine (6 unknowns) from three or more point pairs, row-major 3×3. */
export function fitAffine(from: [number, number][], to: [number, number][]): number[] | null {
  const n = Math.min(from.length, to.length);
  if (n < 3) return null;
  // Two independent 3-unknown systems: u = p x + q y + r, v = s x + t y + w.
  const solve = (rhs: (i: number) => number) => {
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let i = 0; i < n; i++) {
      const row = [from[i][0], from[i][1], 1], k = rhs(i);
      for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) A[r][c] += row[r] * row[c]; A[r][3] += row[r] * k; }
    }
    for (let col = 0; col < 3; col++) {
      let pivot = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
      if (Math.abs(A[pivot][col]) < 1e-12) return null;
      [A[col], A[pivot]] = [A[pivot], A[col]];
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let c = col; c < 4; c++) A[r][c] -= f * A[col][c];
      }
    }
    return A.map((row, i) => row[3] / row[i]);
  };
  const top = solve(i => to[i][0]), bottom = solve(i => to[i][1]);
  if (!top || !bottom) return null;
  return [top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], 0, 0, 1];
}

const MODEL_SAMPLE: Record<PlaneModel, number> = { similarity: 2, affine: 3, homography: 4 };
function fitModel(model: PlaneModel, from: [number, number][], to: [number, number][]): number[] | null {
  return model === "similarity" ? fitSimilarity(from, to) : model === "affine" ? fitAffine(from, to) : fitHomography(from, to);
}

/**
 * The transform of the chosen model most of the tracked points agree on
 * (RANSAC over minimal samples, then a least-squares refit on the inliers).
 * `inliers` says how many points fit within `tolerance` pixels.
 */
export function robustFit(model: PlaneModel, from: [number, number][], to: [number, number][], { tolerance = 1.5, rounds = 64, seed = 7 }: { tolerance?: number; rounds?: number; seed?: number } = {}): { h: number[]; inliers: number } | null {
  const n = Math.min(from.length, to.length), k = MODEL_SAMPLE[model];
  if (n < k) return null;
  let state = seed;
  const random = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const errors = (h: number[]) => from.slice(0, n).map((p, i) => { const [u, v] = applyHomography(h, p[0], p[1]); return Math.hypot(u - to[i][0], v - to[i][1]); });
  let best: { h: number[]; inliers: number[] } | null = null;
  const attempts = n === k ? 1 : rounds;
  for (let round = 0; round < attempts; round++) {
    const picked = new Set<number>();
    while (picked.size < k) picked.add(Math.floor(random() * n));
    const idx = [...picked];
    const h = fitModel(model, idx.map(i => from[i]), idx.map(i => to[i]));
    if (!h) continue;
    const inliers = errors(h).flatMap((e, i) => (e <= tolerance ? [i] : []));
    if (!best || inliers.length > best.inliers.length) best = { h, inliers };
    if (inliers.length === n) break;
  }
  if (!best || best.inliers.length < k) return null;
  const refit = fitModel(model, best.inliers.map(i => from[i]), best.inliers.map(i => to[i])) ?? best.h;
  return { h: refit, inliers: best.inliers.length };
}

/** Scale and rotation a transform applies near a point: how much a plane step grew and turned. */
export function stepChange(h: number[], at: [number, number]): { scale: number; rotation: number } {
  const [x0, y0] = applyHomography(h, at[0], at[1]);
  const [x1, y1] = applyHomography(h, at[0] + 10, at[1]);
  const [x2, y2] = applyHomography(h, at[0], at[1] + 10);
  const sx = Math.hypot(x1 - x0, y1 - y0) / 10, sy = Math.hypot(x2 - x0, y2 - y0) / 10;
  return { scale: Math.sqrt(sx * sy), rotation: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI };
}

export type PlaneStep = { points: [number, number][]; quad: Quad; h: number[]; inliers: number; model: PlaneModel; scale: number; rotation: number };

/**
 * Where a flat surface went between two frames: every point of `points` is
 * followed with `trackPatch`, one transform is fitted to the ones that agree,
 * and the quad's corners are moved by it, so the corners cannot drift apart
 * (ADR 0039). The model is a similarity by default (a wall title through a
 * pan scales, turns and slides; it does not shear or collapse), affine when
 * many points agree, and a full homography only when asked for. A step that
 * would grow, shrink or turn the plane more than a camera can between two
 * samples is refused (null), so the caller holds instead of jumping.
 */
export function trackPlane(prev: Gray, next: Gray, points: [number, number][], quad: Quad, options: { radius?: number; range?: number; lostAt?: number; tolerance?: number; model?: PlaneModel; maxScaleStep?: number; maxRotationStep?: number; minInliers?: number } = {}): PlaneStep | null {
  const { tolerance = 1.5, model = "similarity", maxScaleStep = 0.12, maxRotationStep = 4, minInliers = 4, ...patch } = options;
  const moved = points.map(([x, y]) => trackPatch(prev, next, x, y, patch));
  const kept = moved.flatMap((m, i) => (m.lost ? [] : [i]));
  if (kept.length < Math.max(minInliers, MODEL_SAMPLE[model])) return null;
  const from = kept.map(i => points[i]), to = kept.map(i => [moved[i].x, moved[i].y] as [number, number]);
  // Affine needs enough agreeing points to be better than a similarity, not worse.
  const chosen: PlaneModel = model === "affine" && kept.length < 12 ? "similarity" : model === "homography" && kept.length < 16 ? "affine" : model;
  const fit = robustFit(chosen, from, to, { tolerance });
  if (!fit || fit.inliers < Math.max(minInliers, MODEL_SAMPLE[chosen])) return null;
  const centre: [number, number] = [(quad[0] + quad[2] + quad[4] + quad[6]) / 4, (quad[1] + quad[3] + quad[5] + quad[7]) / 4];
  const change = stepChange(fit.h, centre);
  if (Math.abs(Math.log(change.scale)) > Math.log(1 + maxScaleStep) || Math.abs(change.rotation) > maxRotationStep) return null;
  const nextQuad = [0, 1, 2, 3].flatMap(i => applyHomography(fit.h, quad[i * 2], quad[i * 2 + 1])) as Quad;
  const nextPoints = points.map(p => applyHomography(fit.h, p[0], p[1]));
  return { points: nextPoints, quad: nextQuad, h: fit.h, inliers: fit.inliers, model: chosen, scale: change.scale, rotation: change.rotation };
}

/**
 * Points worth tracking inside a quad: a grid over its bounding box, keeping
 * only those where the picture has detail (gradient energy above a floor),
 * because a patch on a blank wall matches everywhere.
 */
export function planePoints(gray: Gray, quad: Quad, { grid = 6, radius = 6, minEnergy = 20 }: { grid?: number; radius?: number; minEnergy?: number } = {}): [number, number][] {
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
  const x0 = Math.max(radius + 1, Math.min(...xs)), x1 = Math.min(gray.width - radius - 2, Math.max(...xs));
  const y0 = Math.max(radius + 1, Math.min(...ys)), y1 = Math.min(gray.height - radius - 2, Math.max(...ys));
  const out: { p: [number, number]; e: number }[] = [];
  for (let gy = 0; gy < grid; gy++) for (let gx = 0; gx < grid; gx++) {
    const x = Math.round(x0 + ((x1 - x0) * (gx + 0.5)) / grid), y = Math.round(y0 + ((y1 - y0) * (gy + 0.5)) / grid);
    if (x < radius + 1 || y < radius + 1 || x > gray.width - radius - 2 || y > gray.height - radius - 2) continue;
    let energy = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const i = (y + dy) * gray.width + (x + dx);
      energy += Math.abs(gray.data[i + 1] - gray.data[i]) + Math.abs(gray.data[i + gray.width] - gray.data[i]);
    }
    energy /= (2 * radius + 1) ** 2;
    if (energy >= minEnergy) out.push({ p: [x, y], e: energy });
  }
  return out.map(o => o.p);
}

/**
 * A rectangle turned and tilted in 3D and projected back onto the frame: the
 * perspective a title needs to lie on a wall seen at an angle, rather than
 * floating frontal (ADR 0039, third attempt). `yaw` turns it about its
 * vertical axis (positive: the right edge recedes), `pitch` about its
 * horizontal axis (positive: the top recedes), both in degrees; `focal` is the
 * lens in frame widths (1.0 is a normal phone lens). Coordinates are frame
 * fractions; the quad is (tl, tr, br, bl).
 */
export function leanQuad(quad: Quad, yaw: number, pitch: number, focal = 1.0, aspect = 1920 / 1080): Quad {
  if (!yaw && !pitch) return quad;
  const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  const ry = (yaw * Math.PI) / 180, rx = (pitch * Math.PI) / 180;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    // Centre the corner, in square units (frame widths), rotate in 3D, project.
    const x = quad[i * 2] - cx, y = (quad[i * 2 + 1] - cy) * aspect;
    const x1 = x * Math.cos(ry), z1 = x * Math.sin(ry);
    // Frame y runs down, so the top (negative y) recedes for a positive pitch.
    const y2 = y * Math.cos(rx), z2 = z1 - y * Math.sin(rx);
    const depth = focal + z2;
    const k = focal / Math.max(0.2 * focal, depth);
    out.push(cx + x1 * k, cy + (y2 * k) / aspect);
  }
  // Keep the title where the author put it: the projection pulls the quad toward its near side.
  const mx = (out[0] + out[2] + out[4] + out[6]) / 4 - cx, my = (out[1] + out[3] + out[5] + out[7]) / 4 - cy;
  return out.map((v, i) => v - (i % 2 === 0 ? mx : my)) as Quad;
}

/** The inverse of a row-major 3×3 homography (adjugate over determinant), or null when singular. */
export function invertHomography(h: number[]): number[] | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i, B = -(d * j - f * g), C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [A, -(b * j - c * i), b * f - c * e, B, a * j - c * g, -(a * f - c * d), C, -(a * i - b * g), a * e - b * d];
  return inv.map((v) => v / det);
}

/**
 * Four corners in whatever order they were placed, returned as top-left,
 * top-right, bottom-right, bottom-left for an upright, unmirrored title
 * (ADR 0044). The winding is made clockwise on screen (a mirrored order
 * flips the words), then the edge that runs most nearly left to right is
 * taken as the top, so a plane along a road or a slab keeps its own slope.
 */
export function orientQuad(quad: readonly number[]): Quad {
  const order = orientOrder(quad);
  return order.flatMap((i) => [quad[i * 2], quad[i * 2 + 1]]) as Quad;
}

/**
 * The corner order `orientQuad` would use, as indices into the given quad, so
 * a pinned plane and every keyframe tracked from it can be re-ordered the
 * same way (the keyframes' corners follow the plane's order).
 */
export function orientOrder(quad: readonly number[]): [number, number, number, number] {
  const pts: [number, number, number][] = [0, 1, 2, 3].map((i) => [quad[i * 2], quad[i * 2 + 1], i]);
  // Signed area, y down: positive is clockwise on screen.
  let area = 0;
  for (let i = 0; i < 4; i++) { const a = pts[i], b = pts[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
  const wound = area < 0 ? [pts[0], pts[3], pts[2], pts[1]] : pts;
  const lengths = [0, 1, 2, 3].map((k) => { const a = wound[k], b = wound[(k + 1) % 4]; return Math.hypot(b[0] - a[0], b[1] - a[1]); });
  const longest = Math.max(...lengths) || 1e-9;
  let best = 0, bestScore = -Infinity;
  for (let k = 0; k < 4; k++) {
    const a = wound[k], b = wound[(k + 1) % 4];
    const dx = b[0] - a[0];
    const len = lengths[k] || 1e-9;
    // The edge pointing most nearly right, the long edges counting for more: a road's length, not its short end.
    const score = (dx / len) * Math.sqrt(len / longest);
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return [0, 1, 2, 3].map((i) => wound[(best + i) % 4][2]) as [number, number, number, number];
}
