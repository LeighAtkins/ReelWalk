/**
 * Finding the flat surface under a title (ADR 0043). A title that looks
 * painted on a wall needs the wall's own perspective, so the plane comes from
 * the wall's edges: the strongest near-vertical line each side of the title
 * and the strongest near-horizontal line above and below it, found with a
 * gradient-guided Hough transform, intersected into a quad.
 */
import type { Gray, Quad } from "./motion";

export type SurfaceLine = { theta: number; rho: number; votes: number };

/** Edge points of `gray` inside a window: position and gradient direction (radians, the edge's normal). */
function edges(gray: Gray, x0: number, y0: number, x1: number, y1: number, threshold: number): { x: number; y: number; dir: number }[] {
  const out: { x: number; y: number; dir: number }[] = [];
  const { data, width } = gray;
  for (let y = Math.max(1, y0); y < Math.min(gray.height - 1, y1); y++) for (let x = Math.max(1, x0); x < Math.min(width - 1, x1); x++) {
    const i = y * width + x;
    const gx = data[i + 1] - data[i - 1] + 0.5 * (data[i - width + 1] - data[i - width - 1] + data[i + width + 1] - data[i + width - 1]);
    const gy = data[i + width] - data[i - width] + 0.5 * (data[i + width - 1] - data[i - width - 1] + data[i + width + 1] - data[i - width + 1]);
    const magnitude = Math.hypot(gx, gy);
    if (magnitude >= threshold) out.push({ x, y, dir: Math.atan2(gy, gx) });
  }
  return out;
}

/**
 * Straight lines through the edge points, as (theta, rho) with
 * x cosθ + y sinθ = rho, θ in [0, π). Each point votes only near its own
 * gradient direction, so texture does not drown the real edges. Peaks are
 * kept after a small non-maximum suppression.
 */
export function houghLines(points: { x: number; y: number; dir: number }[], width: number, height: number, { thetaStep = Math.PI / 90, minVotes = 20, max = 40 }: { thetaStep?: number; minVotes?: number; max?: number } = {}): SurfaceLine[] {
  const thetas = Math.round(Math.PI / thetaStep);
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhos = diagonal * 2 + 1;
  const acc = new Int32Array(thetas * rhos);
  const spread = 4; // ±4 theta bins (±8°) around the gradient direction
  for (const p of points) {
    const centre = Math.round((((p.dir % Math.PI) + Math.PI) % Math.PI) / thetaStep);
    for (let d = -spread; d <= spread; d++) {
      // theta wraps at pi; rho computed with the wrapped theta is already that line's rho (it changes sign with theta).
      const t = ((centre + d) % thetas + thetas) % thetas;
      const theta = t * thetaStep;
      const rho = Math.round(p.x * Math.cos(theta) + p.y * Math.sin(theta)) + diagonal;
      if (rho >= 0 && rho < rhos) acc[t * rhos + rho]++;
    }
  }
  const peaks: SurfaceLine[] = [];
  for (let t = 0; t < thetas; t++) for (let r = 0; r < rhos; r++) {
    const v = acc[t * rhos + r];
    if (v < minVotes) continue;
    let isMax = true;
    for (let dt = -2; dt <= 2 && isMax; dt++) for (let dr = -3; dr <= 3; dr++) {
      const tt = (t + dt + thetas) % thetas, rr = r + dr;
      if (rr < 0 || rr >= rhos || (dt === 0 && dr === 0)) continue;
      if (acc[tt * rhos + rr] > v) { isMax = false; break; }
    }
    if (isMax) peaks.push({ theta: t * thetaStep, rho: r - diagonal, votes: v });
  }
  // One line per edge: a real edge voted into a diagonal ridge of nearby (theta, rho) bins, so keep the
  // strongest and drop near-parallel neighbours that cross the frame's centre close to it.
  const kept: SurfaceLine[] = [];
  const cx = width / 2, cy = height / 2;
  const offset = (l: SurfaceLine) => l.rho - (cx * Math.cos(l.theta) + cy * Math.sin(l.theta));
  for (const peak of peaks.sort((a, b) => b.votes - a.votes)) {
    // Near-parallel and at the same signed distance from the centre: two edges at equal distance on
    // opposite sides (a window's two jambs) are both kept. A direction that wraps past π flips the sign.
    const dup = kept.some((k) => { const dt = Math.abs(((k.theta - peak.theta) % Math.PI + Math.PI) % Math.PI); const near = Math.min(dt, Math.PI - dt) <= Math.PI / 30; const flipped = dt > Math.PI / 2; return near && Math.abs(offset(k) - (flipped ? -offset(peak) : offset(peak))) <= Math.min(width, height) * 0.03; });
    if (!dup) kept.push(peak);
    if (kept.length >= max) break;
  }
  return kept;
}

function intersect(a: SurfaceLine, b: SurfaceLine): [number, number] | null {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-9) return null;
  return [(a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det, (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det];
}

/** Angular distance between two line directions, in [0, π/2]. */
const angleGap = (a: number, b: number) => { const d = Math.abs(((a - b) % Math.PI + Math.PI) % Math.PI); return Math.min(d, Math.PI - d); };
/** Signed distance of a point from a line along the line's normal. */
const offset = (l: SurfaceLine, x: number, y: number) => x * Math.cos(l.theta) + y * Math.sin(l.theta) - l.rho;

export type Surface = { quad: Quad; sides: { left: number; right: number; top: number; bottom: number } };

/**
 * The flat surface around (cx, cy): the picture's two dominant families of
 * straight lines near the point (whatever their angle: a wall seen in
 * perspective has slanted edges), and in each family the strongest line on
 * either side of the point, intersected into a quad in the frame's pixel
 * units. A side with no edge (the wall runs off the frame) falls back to the
 * search window's boundary. `sides` carry each side's votes (0 for a
 * fallback), so the UI can say which corners to check.
 */
export function findSurfaceQuad(gray: Gray, cx: number, cy: number, { searchX = 0.42, searchY = 0.3, threshold = 24, minGap = 0.03 }: { searchX?: number; searchY?: number; threshold?: number; minGap?: number } = {}): Surface | null {
  const { width, height } = gray;
  const x0 = Math.round(cx - searchX * width), x1 = Math.round(cx + searchX * width);
  const y0 = Math.round(cy - searchY * height), y1 = Math.round(cy + searchY * height);
  const points = edges(gray, x0, y0, x1, y1, threshold);
  if (points.length < 40) return null;
  const lines = houghLines(points, width, height, { minVotes: Math.round(Math.min(width, height) * 0.08) });
  if (!lines.length) return null;
  // Two families by the picture's axes, generously: walls in perspective lean up to 40° from upright.
  const upright = (l: SurfaceLine) => angleGap(l.theta, 0) <= (Math.PI * 40) / 180;
  const familyA = lines.filter(upright), familyB = lines.filter((l) => !upright(l));
  const thetaA = familyA[0]?.theta ?? 0, thetaB = familyB[0]?.theta ?? Math.PI / 2;
  const gap = minGap * Math.min(width, height);
  // On each side of the point: the nearest strong line within reach; nearer beats stronger once both are real.
  const pick = (family: SurfaceLine[], theta: number, sign: 1 | -1): SurfaceLine => {
    const reach = Math.abs(Math.cos(theta)) * searchX * width + Math.abs(Math.sin(theta)) * searchY * height;
    const candidates = family.filter((l) => sign * offset(l, cx, cy) > gap && sign * offset(l, cx, cy) <= reach);
    const score = (l: SurfaceLine) => l.votes * (1 - 0.6 * (Math.abs(offset(l, cx, cy)) / reach));
    const best = candidates.sort((p, q) => score(q) - score(p))[0];
    // No edge that way: the surface reaches the edge of the search window.
    return best ?? { theta, rho: cx * Math.cos(theta) + cy * Math.sin(theta) - sign * reach, votes: 0 };
  };
  const aNeg = pick(familyA, thetaA, -1), aPos = pick(familyA, thetaA, 1);
  const bNeg = pick(familyB, thetaB, -1), bPos = pick(familyB, thetaB, 1);
  // At most one side may be a fallback: with two or more the "surface" is just the search window.
  if ([aNeg, aPos, bNeg, bPos].filter((l) => l.votes === 0).length > 1) return null;
  const corners = [intersect(aNeg, bNeg), intersect(aPos, bNeg), intersect(aPos, bPos), intersect(aNeg, bPos)];
  if (corners.some((c) => !c)) return null;
  // Order the corners tl, tr, br, bl by their angle about the point.
  const ordered = (corners as [number, number][]).map((c) => ({ c, angle: Math.atan2(c[1] - cy, c[0] - cx) })).sort((p, q) => p.angle - q.angle).map((o) => o.c);
  // atan2 order from -π: the first is the most "left-up" corner; rotate so the smallest x+y is first (top-left).
  let startIndex = 0;
  for (let i = 1; i < 4; i++) if (ordered[i][0] + ordered[i][1] < ordered[startIndex][0] + ordered[startIndex][1]) startIndex = i;
  const rotated = [0, 1, 2, 3].map((i) => ordered[(startIndex + i) % 4]);
  const quad = rotated.flat() as Quad;
  // Sanity: a convex quad of a usable size, not the whole frame.
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  if (w < width * 0.12 || h < height * 0.04 || w > width * 1.1 || h > height * 0.7) return null;
  // Convex, with no corner wildly outside the frame.
  if (xs.some((x) => x < -width * 0.2 || x > width * 1.2) || ys.some((y) => y < -height * 0.2 || y > height * 1.2)) return null;
  const cross = (i: number) => { const ax = quad[(i * 2 + 2) % 8] - quad[i * 2], ay = quad[(i * 2 + 3) % 8] - quad[i * 2 + 1], bx = quad[(i * 2 + 4) % 8] - quad[(i * 2 + 2) % 8], by = quad[(i * 2 + 5) % 8] - quad[(i * 2 + 3) % 8]; return ax * by - ay * bx; };
  const signs = [0, 1, 2, 3].map((i) => Math.sign(cross(i)));
  if (new Set(signs.filter((v) => v !== 0)).size > 1) return null;
  // Which pick landed on which side: upright lines are left or right of the point, the others above or below.
  const sides = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const l of [aNeg, aPos, bNeg, bPos]) {
    const o = offset(l, cx, cy);
    if (upright(l)) { if (o * Math.cos(l.theta) > 0) sides.left = l.votes; else sides.right = l.votes; }
    else { if (o * Math.sin(l.theta) > 0) sides.top = l.votes; else sides.bottom = l.votes; }
  }
  return { quad, sides };
}
