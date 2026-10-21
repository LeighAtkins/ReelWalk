/**
 * Synthetic surface-tracking sequences with known ground truth (ADR 0052).
 *
 * Each frame is rendered by inverse mapping: a textured wall plane moves by a
 * known homography per frame, a background on another depth plane moves by a
 * different one (parallax: the trap the old tracker fell into by borrowing
 * features from around the surface), an optional occluder sweeps across in
 * screen space, and sensor noise is added. Everything is a deterministic
 * function of (x, y, frame, seed).
 */
import { applyHomography, homography, invertHomography, type Gray, type Quad } from "../../src";

export type Scenario = {
  name: string;
  frames: Gray[];
  /** The author's quad at frame 0, px (tl, tr, br, bl). */
  quad: Quad;
  /** Where that quad truly is in every frame. */
  truth: Quad[];
  /** "reject" when no tracker should claim confidence (a blank wall). */
  expect: "track" | "reject";
};

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(u: number, v: number, seed: number): number {
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed), c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Plaster-and-tile-like texture in plane units (≈ frame-0 pixels at 360 wide, scaled by `k`). */
function texture(u: number, v: number, seed: number, k: number): number {
  const x = u / k, y = v / k;
  let t = 0.45 * valueNoise(x / 9, y / 9, seed) + 0.35 * valueNoise(x / 4, y / 4, seed + 1) + 0.2 * valueNoise(x / 2, y / 2, seed + 2);
  if (hash(Math.floor(x / 7), Math.floor(y / 7), seed + 3) > 0.75) t += 0.35;
  return 30 + 180 * Math.min(1, t);
}

const translate = (dx: number, dy: number) => [1, 0, dx, 0, 1, dy, 0, 0, 1];
const about = (cx: number, cy: number, s: number, deg: number) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r) * s, n = Math.sin(r) * s;
  return [c, -n, cx - c * cx + n * cy, n, c, cy - n * cx - c * cy, 0, 0, 1];
};
const mapQuad = (h: number[], q: Quad) => [0, 1, 2, 3].flatMap((i) => applyHomography(h, q[i * 2], q[i * 2 + 1])) as Quad;

type Spec = {
  name: string;
  wall: (k: number) => number[];
  background: (k: number) => number[];
  blank?: boolean;
  occluder?: (k: number) => { x0: number; x1: number; y0: number; y1: number } | null;
  /** From this frame on the shot is a different picture (a cut): the surface is gone and no position is right. */
  cutAt?: number;
  expect?: "track" | "reject";
};

function render(spec: Spec, width: number, height: number, count: number, noise: number): Scenario {
  const s = width / 360;
  const quad: Quad = [0.3 * width, 0.33 * height, 0.7 * width, 0.33 * height, 0.7 * width, 0.51 * height, 0.3 * width, 0.51 * height];
  const toUnit = homography(quad, [0, 0, 1, 0, 1, 1, 0, 1])!;
  const frames: Gray[] = [], truth: Quad[] = [];
  for (let k = 0; k < count; k++) {
    const W = spec.wall(k), B = spec.background(k);
    const Wi = invertHomography(W)!, Bi = invertHomography(B)!;
    const occ = spec.occluder?.(k) ?? null;
    const cut = spec.cutAt !== undefined && k >= spec.cutAt;
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let value: number;
      if (cut) {
        value = texture(x + 13 * k, y, 203, s); // another room, panning
      } else if (occ && x >= occ.x0 && x < occ.x1 && y >= occ.y0 && y < occ.y1) {
        value = texture(x - occ.x0, y - occ.y0, 91, s) * 0.6 + 20; // a person-like textured block riding in front
      } else {
        const [px, py] = applyHomography(Wi, x, y);
        const [u, v] = applyHomography(toUnit, px, py);
        if (u > -0.35 && u < 1.35 && v > -0.6 && v < 1.6) {
          value = spec.blank ? 140 + 8 * valueNoise(px / (40 * s), py / (40 * s), 5) : texture(px, py, 11, s);
        } else {
          const [bx, by] = applyHomography(Bi, x, y);
          value = texture(bx, by, 47, s);
        }
      }
      data[y * width + x] = value + (hash(x, y, 1000 + k) - 0.5) * 2 * Math.sqrt(3) * noise;
    }
    frames.push({ data, width, height });
    truth.push(cut ? (quad.map(() => Infinity) as Quad) : mapQuad(W, quad));
  }
  return { name: spec.name, frames, quad, truth, expect: spec.expect ?? "track" };
}

/** The benchmark set at a given size (360 × 640 is the editor's tracking size). */
export function scenarios(width = 360, height = 640, count = 30, noise = 2): Scenario[] {
  const s = width / 360;
  const cx = width / 2, cy = height * 0.42;
  // A wall plane at depth 1 turning about its vertical axis, projected with a focal length of one frame width.
  const orbit = (k: number) => {
    const quad: Quad = [0.3 * width, 0.33 * height, 0.7 * width, 0.33 * height, 0.7 * width, 0.51 * height, 0.3 * width, 0.51 * height];
    const f = width, th = (0.9 * k * Math.PI) / 180;
    const moved = [0, 1, 2, 3].flatMap((i) => {
      const X = (quad[i * 2] - cx) / f, Y = (quad[i * 2 + 1] - cy) / f;
      const x = X * Math.cos(th), z = 1 + X * Math.sin(th);
      return [cx + (f * x) / z - 1.5 * s * k, cy + (f * Y) / z];
    }) as Quad;
    return homography(quad, moved)!;
  };
  const specs: Spec[] = [
    { name: "pan (parallax)", wall: (k) => translate(-2.5 * s * k, 0.4 * s * k), background: (k) => translate(-0.8 * s * k, 0.1 * s * k) },
    { name: "push-in", wall: (k) => about(cx, cy, 1 + 0.012 * k, 0), background: (k) => about(cx, cy, 1 + 0.004 * k, 0) },
    { name: "orbit (perspective)", wall: orbit, background: (k) => translate(1.2 * s * k, 0) },
    { name: "handheld", wall: (k) => mulT(translate(4 * s * Math.sin(k / 2), 3 * s * Math.cos(k / 2.5) - 3 * s), about(cx, cy, 1, 1.5 * Math.sin(k / 3))), background: (k) => mulT(translate(2 * s * Math.sin(k / 2), 1.5 * s * Math.cos(k / 2.5) - 1.5 * s), about(cx, cy, 1, 1.5 * Math.sin(k / 3))) },
    {
      name: "occluded pan", wall: (k) => translate(-1.5 * s * k, 0), background: (k) => translate(-0.5 * s * k, 0),
      occluder: (k) => (k >= 6 && k <= 22 ? { x0: width * (0.9 - 0.045 * (k - 6)), x1: width * (0.9 - 0.045 * (k - 6)) + width * 0.16, y0: height * 0.28, y1: height * 0.75 } : null),
    },
    {
      name: "heavy occluder", wall: (k) => translate(-1.2 * s * k, 0.3 * s * k), background: (k) => translate(-0.4 * s * k, 0),
      occluder: (k) => (k >= Math.round(count * 0.3) && k <= Math.round(count * 0.6) ? { x0: width * 0.22, x1: width * 0.62, y0: height * 0.2, y1: height * 0.8 } : null),
    },
    { name: "cut mid-shot", wall: (k) => translate(-2 * s * k, 0), background: (k) => translate(-0.7 * s * k, 0), cutAt: Math.round(count / 2) },
    { name: "leaves frame", wall: (k) => translate(-6 * s * k, 0), background: (k) => translate(-2 * s * k, 0) },
    { name: "blank wall", wall: (k) => translate(-2.5 * s * k, 0.4 * s * k), background: (k) => translate(-0.8 * s * k, 0.1 * s * k), blank: true, expect: "reject" },
  ];
  return specs.map((spec) => render(spec, width, height, count, noise));
}

function mulT(p: number[], q: number[]): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = p[r * 3] * q[c] + p[r * 3 + 1] * q[3 + c] + p[r * 3 + 2] * q[6 + c];
  return out;
}

/** Mean distance between corresponding corners, px. */
export function cornerError(a: Quad, b: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(a[i * 2] - b[i * 2], a[i * 2 + 1] - b[i * 2 + 1]);
  return s / 4;
}

/** A frame filled with the benchmark texture seen through `h` (frame-0 plane → this frame), optionally blank outside `keep`. */
export function texturedFrame(width: number, height: number, h: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1], seed = 11, noise = 0, scale = width / 360): Gray {
  const inv = invertHomography(h)!;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [u, v] = applyHomography(inv, x, y);
    data[y * width + x] = texture(u, v, seed, scale) + (noise ? (hash(x, y, seed + 77) - 0.5) * 2 * Math.sqrt(3) * noise : 0);
  }
  return { data, width, height };
}
