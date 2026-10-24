/**
 * What the camera is doing at a cut (ADR 0074): pan, tilt, push in, pull out,
 * roll or nothing, read from a few small grey frames at the edge of a clip.
 *
 * The block matching of motion.ts finds one dominant integer shift per frame
 * pair. That is enough for a pan, but it cannot tell a dolly from a pan (a
 * forward move has no dominant shift: the picture expands from a point) and it
 * reads slow footage as still (a drift of 0.05 frame-widths a second is two
 * pixels a second at 48 px wide, under the 5 px/s still threshold of match
 * cuts). This module instead fits one affine flow to the whole frame by
 * gradient-based alignment (Lucas-Kanade on a pyramid, robust weights), which
 * is exact to a fraction of a pixel on textured footage and reads the
 * translation, the divergence (expansion) and the curl (rotation) together.
 *
 *   flow(p) = t + A·p,   div = (A00 + A11) / 2,   curl = (A10 − A01) / 2
 *
 * with p in frame widths from the centre. The estimate is over the longest
 * gap the window allows (first frame to last), started from the sum of the
 * steps between consecutive frames so a fast pan still converges.
 *
 * Pure arithmetic on `Gray` frames (motion.ts): the browser or a script makes
 * the frames, so it is tested on synthetic flows.
 */
import { z } from "zod";
import type { Gray } from "./motion";

export const MOTION_KINDS = ["pan-x", "pan-y", "zoom-in", "zoom-out", "rotate", "still"] as const;
export const motionKindSchema = z.enum(MOTION_KINDS);
export type MotionKind = z.infer<typeof motionKindSchema>;

/** Below this edge speed (frame widths a second) the camera reads as still: a fifth of the slowest drift worth following (0.1). */
export const STILL_FW_PER_S = 0.02;
/** A zoom wins over a pan up to this far ahead of it: a dolly with the vanishing point off-centre also slides the picture. */
const ZOOM_BIAS = 1.33;
/** Frames this small are enough, and cheaper; the pyramid stops here. */
const COARSEST_WIDTH = 24;
/** Under this mean squared gradient the picture has no detail to follow (a blank wall, a sky). */
const FLAT_TEXTURE = 6;

export const motionReadSchema = z.object({
  kind: motionKindSchema,
  /** The dominant movement as the edge speed of the frame, frame widths a second (>= 0). */
  speed: z.number().min(0),
  /** Content velocity, frame widths a second: tx > 0 moves right, ty > 0 moves down (the camera pans the other way). */
  tx: z.number(),
  ty: z.number(),
  /** Scale growth a second (0.1 = the picture grows 10 % a second): > 0 is a push in, < 0 a pull out. */
  zoom: z.number(),
  /** Roll in radians a second, > 0 clockwise on screen. */
  rotate: z.number(),
  /** Where the picture expands from (or shrinks toward), frame fractions, for a zoom; null otherwise. */
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable(),
  /** How far the reading can be trusted, 0..1 (0 for a frame with no detail). */
  confidence: z.number().min(0).max(1),
});
export type MotionRead = z.infer<typeof motionReadSchema>;

/** What a ramp side keeps of a read: the kind and, for a zoom, where it streaks from. */
export const sideReadSchema = z.object({
  kind: motionKindSchema,
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
});
export type SideRead = z.infer<typeof sideReadSchema>;

/** The measured footage on either side of a speed-ramp cut (stored on the incoming clip): its own opening, and the outgoing clip's closing. */
export const rampFootageSchema = z.object({
  /** The clip the outgoing read is of: a read of some other clip (the reel was reordered since) is not used. */
  after: z.string().min(1).optional(),
  out: sideReadSchema.optional(),
  in: sideReadSchema.optional(),
});
export type RampFootage = z.infer<typeof rampFootageSchema>;

export const sideReadOf = (read: MotionRead): SideRead => ({ kind: read.kind, ...(read.focus && (read.kind === "zoom-in" || read.kind === "zoom-out") ? { focus: read.focus } : {}) });

// ── Images ──────────────────────────────────────────────────────

function blur3(g: Gray): Gray {
  const { width: w, height: h, data } = g;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = data[y * w + Math.max(0, x - 1)], c = data[y * w + x], r = data[y * w + Math.min(w - 1, x + 1)];
    tmp[y * w + x] = (l + 2 * c + r) / 4;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[y * w + x] = (tmp[Math.max(0, y - 1) * w + x] + 2 * tmp[y * w + x] + tmp[Math.min(h - 1, y + 1) * w + x]) / 4;
  }
  return { data: out, width: w, height: h };
}

function halve(g: Gray): Gray {
  const w = Math.floor(g.width / 2), h = Math.floor(g.height / 2);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * g.width + 2 * x;
    out[y * w + x] = (g.data[i] + g.data[i + 1] + g.data[i + g.width] + g.data[i + g.width + 1]) / 4;
  }
  return { data: out, width: w, height: h };
}

function pyramid(g: Gray): Gray[] {
  const levels = [blur3(g)];
  while (levels[levels.length - 1].width / 2 >= COARSEST_WIDTH && levels[levels.length - 1].height / 2 >= COARSEST_WIDTH) levels.push(halve(levels[levels.length - 1]));
  return levels;
}

function bilinear(g: Gray, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const i = y0 * g.width + x0;
  const d = g.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.width] * (1 - fx) + d[i + g.width + 1] * fx) * fy;
}

// ── One level ───────────────────────────────────────────────────

/** [tx, ty, a00, a01, a10, a11] in pixels of a level, with the matrix over coordinates from the centre in half-widths. */
type Theta = [number, number, number, number, number, number];

type Solved = { theta: Theta; inliers: number; texture: number };

/** Solves the n×n system M x = rhs in place (Gaussian elimination, partial pivoting); null when singular. */
function solve(M: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
      rhs[r] -= f * rhs[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = rhs[r];
    for (let c = r + 1; c < n; c++) sum -= M[r][c] * x[c];
    x[r] = sum / M[r][r];
  }
  return x;
}

/**
 * Gauss-Newton alignment of `b` onto `a` at one level, from `start`: finds the
 * flow that makes b(p + flow(p)) match a(p). Robust (Tukey weights from the
 * median residual), so a person walking through the shot does not pull the
 * camera's motion with them.
 */
function align(a: Gray, b: Gray, start: Theta, iterations: number): Solved {
  const { width: w, height: h } = a;
  const half = w / 2, cx = w / 2 - 0.5, cy = h / 2 - 0.5;
  let theta: Theta = [...start];
  const margin = 2;
  const count = w * h;
  const residual = new Float32Array(count);
  const gx = new Float32Array(count), gy = new Float32Array(count), valid = new Uint8Array(count);
  let inliers = 0, texture = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sorted: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const X = (x - cx) / half, Y = (y - cy) / half;
      const u = theta[0] + theta[2] * X + theta[3] * Y, v = theta[1] + theta[4] * X + theta[5] * Y;
      const sx = x + u, sy = y + v;
      if (sx < margin || sy < margin || sx > w - 1 - margin || sy > h - 1 - margin) { valid[i] = 0; continue; }
      valid[i] = 1;
      residual[i] = bilinear(b, sx, sy) - a.data[i];
      gx[i] = (bilinear(b, sx + 1, sy) - bilinear(b, sx - 1, sy)) / 2;
      gy[i] = (bilinear(b, sx, sy + 1) - bilinear(b, sx, sy - 1)) / 2;
      sorted.push(Math.abs(residual[i]));
    }
    if (sorted.length < 64) return { theta, inliers: 0, texture: 0 };
    sorted.sort((p, q) => p - q);
    const scale = Math.max(1.4826 * sorted[sorted.length >> 1], 1.0);
    const cutoff = 4.685 * scale;

    const M = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const rhs = new Array<number>(6).fill(0);
    let kept = 0, energy = 0, used = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!valid[i]) continue;
      used++;
      energy += gx[i] * gx[i] + gy[i] * gy[i];
      const r = residual[i];
      const q = Math.abs(r) / cutoff;
      if (q >= 1) continue;
      kept++;
      const wt = (1 - q * q) * (1 - q * q);
      const X = (x - cx) / half, Y = (y - cy) / half;
      const d = [gx[i], gy[i], gx[i] * X, gx[i] * Y, gy[i] * X, gy[i] * Y];
      for (let p = 0; p < 6; p++) {
        const dp = d[p] * wt;
        rhs[p] -= dp * r;
        for (let q2 = p; q2 < 6; q2++) M[p][q2] += dp * d[q2];
      }
    }
    for (let p = 0; p < 6; p++) for (let q2 = 0; q2 < p; q2++) M[p][q2] = M[q2][p];
    texture = used ? energy / used : 0;
    inliers = used ? kept / used : 0;
    // A flat picture has no motion to read: keep the start (the caller reports zero confidence).
    if (texture < FLAT_TEXTURE * 0.25) return { theta, inliers, texture };
    const ridge = 1e-3 * (M[0][0] + M[1][1]) / 2 + 1e-6;
    for (let p = 0; p < 6; p++) M[p][p] += ridge;
    const delta = solve(M, rhs);
    if (!delta) break;
    theta = theta.map((value, p) => value + delta[p]) as Theta;
    if (Math.max(...delta.map(Math.abs)) < 0.005) break;
  }
  return { theta, inliers, texture };
}

// ── The estimate ────────────────────────────────────────────────

/** The flow between two frames in natural units: tx, ty in frame widths, A dimensionless (growth and rotation over the interval). */
type Flow = { tx: number; ty: number; a00: number; a01: number; a10: number; a11: number };

const ZERO: Flow = { tx: 0, ty: 0, a00: 0, a01: 0, a10: 0, a11: 0 };

/** From natural units to a level's theta: the matrix is over half-widths, so a_px = A · (half-width px). */
function toTheta(flow: Flow, levelWidth: number): Theta {
  const half = levelWidth / 2;
  return [flow.tx * levelWidth, flow.ty * levelWidth, flow.a00 * half, flow.a01 * half, flow.a10 * half, flow.a11 * half];
}

/** A over half-widths from p in half-widths: u = A·(p/half) → in frame widths, A is the growth per half-width, i.e. the same dimensionless matrix. */
function fromTheta(theta: Theta, levelWidth: number): Flow {
  const half = levelWidth / 2;
  return { tx: theta[0] / levelWidth, ty: theta[1] / levelWidth, a00: theta[2] / half, a01: theta[3] / half, a10: theta[4] / half, a11: theta[5] / half };
}

/** Aligns `b` onto `a` coarse to fine, starting from `init`; the flow, and how much detail and agreement it rests on. */
function estimateFlow(a: Gray[], b: Gray[], init: Flow): { flow: Flow; inliers: number; texture: number } {
  let flow = init;
  let inliers = 0, texture = 0;
  for (let level = a.length - 1; level >= 0; level--) {
    const solved = align(a[level], b[level], toTheta(flow, a[level].width), level === 0 ? 4 : 6);
    flow = fromTheta(solved.theta, a[level].width);
    if (level === 0) { inliers = solved.inliers; texture = solved.texture; }
  }
  return { flow, inliers, texture };
}

export type MotionFrame = { t: number; gray: Gray };

/** How much of a clip's edge is read for its blur: half a second, long enough for a slow drift to move a pixel, short enough to be the move the cut lands on. */
export const EDGE_WINDOW_MS = 500;

/**
 * The source times (ms) to sample for the read at a clip's head or tail: three frames across the last or first half
 * second of what plays (the window is half a second of screen time, so `speed` times that of source), the last one a
 * little short of the end so it is still a frame of the clip.
 */
export function edgeSampleTimes(side: "head" | "tail", sourceStartMs: number, sourceEndMs: number, speed = 1): number[] {
  const window = Math.min(sourceEndMs - sourceStartMs, EDGE_WINDOW_MS * Math.max(0.25, speed));
  const from = side === "head" ? sourceStartMs : sourceEndMs - window;
  const last = side === "head" ? from + window - 40 : sourceEndMs - 40;
  return [from, (from + last) / 2, last].map((t) => Math.max(0, Math.round(t)));
}

/**
 * The camera's motion over a window of frames (>= 2, times in ms, same size),
 * classified. Null when the frames cannot be compared (too few, different
 * sizes, under 50 ms apart).
 *
 * The estimate is over the whole window (first to last frame, the longest
 * gap, so a drift of a few hundredths of a frame width a second adds up to
 * more than a pixel), started from the sum of the steps between neighbouring
 * frames. Rates are per second.
 */
export function readMotion(frames: readonly MotionFrame[]): MotionRead | null {
  if (frames.length < 2) return null;
  const sorted = [...frames].sort((p, q) => p.t - q.t);
  const { width, height } = sorted[0].gray;
  if (sorted.some((frame) => frame.gray.width !== width || frame.gray.height !== height) || width < 16 || height < 16) return null;
  const seconds = (sorted[sorted.length - 1].t - sorted[0].t) / 1000;
  if (seconds < 0.05) return null;
  const levels = sorted.map((frame) => pyramid(frame.gray));

  let start = ZERO;
  if (sorted.length > 2) {
    // The steps between neighbours are small enough to find for the fastest pan; their sum starts the long one.
    start = { ...ZERO };
    for (let i = 1; i < sorted.length; i++) {
      const step = estimateFlow(levels[i - 1], levels[i], ZERO).flow;
      start = { tx: start.tx + step.tx, ty: start.ty + step.ty, a00: start.a00 + step.a00, a01: start.a01 + step.a01, a10: start.a10 + step.a10, a11: start.a11 + step.a11 };
    }
  }
  const { flow, inliers, texture } = estimateFlow(levels[0], levels[levels.length - 1], start);

  const tx = flow.tx / seconds, ty = flow.ty / seconds;
  // A is dimensionless: its mean diagonal is the scale growth over the window, its antisymmetric part the roll.
  const zoom = ((flow.a00 + flow.a11) / 2) / seconds;
  const rotate = ((flow.a10 - flow.a01) / 2) / seconds;
  return classify({ tx, ty, zoom, rotate, texture, inliers });
}

/** The dominant motion of rates (frame widths and radians a second), with the call and the confidence. Exported for tests and for callers with their own flow. */
export function classify(rates: { tx: number; ty: number; zoom: number; rotate: number; texture?: number; inliers?: number }): MotionRead {
  const { tx, ty, zoom, rotate } = rates;
  // Edge speeds: how fast the middle of an edge of the frame moves under each motion, in frame widths a second.
  const pan = Math.hypot(tx, ty), zoomEdge = Math.abs(zoom) * 0.5, rollEdge = Math.abs(rotate) * 0.5;
  const confidence = confidenceOf(rates.texture, rates.inliers);
  const base = { tx: round4(tx), ty: round4(ty), zoom: round4(zoom), rotate: round4(rotate), confidence };
  const peak = Math.max(pan, zoomEdge, rollEdge);
  if (peak < STILL_FW_PER_S || confidence === 0) return { kind: "still", speed: round4(peak), focus: null, ...base };
  // Rotation is the rarest call, so it must lead plainly; a zoom is allowed to carry a little slide with it.
  if (rollEdge >= pan && rollEdge >= zoomEdge * ZOOM_BIAS) return { kind: "rotate", speed: round4(rollEdge), focus: null, ...base };
  if (zoomEdge * ZOOM_BIAS >= pan) {
    // flow = zoom·(p − focus) → translation = −zoom·focus.
    const focus = { x: clamp01(0.5 - tx / zoom), y: clamp01(0.5 - ty / zoom) };
    return { kind: zoom > 0 ? "zoom-in" : "zoom-out", speed: round4(zoomEdge), focus: { x: round3(Math.min(0.8, Math.max(0.2, focus.x))), y: round3(Math.min(0.8, Math.max(0.2, focus.y))) }, ...base };
  }
  return { kind: Math.abs(tx) >= Math.abs(ty) ? "pan-x" : "pan-y", speed: round4(pan), focus: null, ...base };
}

/** Trust in a read: none for a frame with no detail, rising with how much of the picture agrees on one flow. */
function confidenceOf(texture = FLAT_TEXTURE * 4, inliers = 1): number {
  if (texture < FLAT_TEXTURE) return 0;
  const detail = Math.min(1, texture / (FLAT_TEXTURE * 8));
  return round2(Math.min(1, detail * 0.4 + Math.min(1, inliers) * 0.6));
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round4 = (value: number) => Math.round(value * 10000) / 10000;

/** A read in a sentence, for the cut report and the sheet. */
export function describeMotionKind(kind: MotionKind): string {
  switch (kind) {
    case "zoom-in": return "forward move";
    case "zoom-out": return "backward move";
    case "pan-x": return "sideways pan";
    case "pan-y": return "tilt";
    case "rotate": return "roll";
    default: return "no clear movement";
  }
}
