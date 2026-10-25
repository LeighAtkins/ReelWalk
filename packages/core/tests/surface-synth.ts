/**
 * Synthetic frames with known surfaces (ADR 0075): textured planes with known corners on a textured
 * background, drawn by inverse mapping, so the finder's output can be compared with the truth.
 */
import { applyHomography, homography, type Gray, type Quad } from "../src";

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise(u: number, v: number, seed: number): number {
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed), c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
/** Plaster-like detail with speckle, around `base` grey. */
export function texture(x: number, y: number, seed: number, base: number, amount = 60): number {
  const t = 0.5 * noise(x / 7, y / 7, seed) + 0.3 * noise(x / 3, y / 3, seed + 1) + 0.2 * noise(x / 1.5, y / 1.5, seed + 2);
  const speck = hash(Math.floor(x / 4), Math.floor(y / 4), seed + 3) > 0.8 ? 0.35 : 0;
  return base + (t + speck - 0.5) * amount * 2;
}
/** `stick`: the texture belongs to the plane (it moves with it); otherwise it belongs to the frame. */
export type Layer = { quad: Quad; base: number; seed: number; amount?: number; stick?: boolean };
export const W = 360, H = 640;
export function render(layers: Layer[], bg: { base: number; seed: number; amount?: number }, fill?: (x: number, y: number) => number | null): Gray {
  const data = new Float32Array(W * H);
  const inv = layers.map((l) => homography(l.quad, [0, 0, 1, 0, 1, 1, 0, 1])!);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = fill?.(x, y) ?? texture(x, y, bg.seed, bg.base, bg.amount ?? 40);
    layers.forEach((l, i) => {
      const [u, w] = applyHomography(inv[i], x + 0.5, y + 0.5);
      if (u >= 0 && u <= 1 && w >= 0 && w <= 1) v = l.stick ? texture(u * 300, w * 300, l.seed, l.base, l.amount ?? 45) : texture(x, y, l.seed, l.base, l.amount ?? 45);
    });
    data[y * W + x] = Math.max(0, Math.min(255, v));
  }
  return { data, width: W, height: H };
}
export const px = (q: readonly number[]) => q.map((v, i) => (i % 2 === 0 ? v * W : v * H)) as Quad;
/** Largest corner distance between two quads, in fractions of the frame. */
export const corners = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
