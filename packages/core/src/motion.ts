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
export function smoothKeyframes<T extends { t: number; x: number; y: number; s?: number; r?: number }>(points: T[], passes = 2): T[] {
  if (points.length < 3) return points;
  const keys = ["x", "y", "s", "r"] as const;
  const values = points.map(p => ({ x: p.x, y: p.y, s: p.s ?? 1, r: p.r ?? 0 }));
  for (let pass = 0; pass < passes; pass++) {
    const before = values.map(v => ({ ...v }));
    for (let i = 1; i < values.length - 1; i++) for (const k of keys) values[i][k] = (before[i - 1][k] + 2 * before[i][k] + before[i + 1][k]) / 4;
  }
  return points.map((p, i) => ({ ...p, x: Number(values[i].x.toFixed(4)), y: Number(values[i].y.toFixed(4)), ...(p.s !== undefined ? { s: Number(values[i].s.toFixed(3)) } : {}), ...(p.r !== undefined ? { r: Number(values[i].r.toFixed(2)) } : {}) }));
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
