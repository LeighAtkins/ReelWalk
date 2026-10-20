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
    const dup = kept.some((k) => { const dt = Math.abs(((k.theta - peak.theta) % Math.PI + Math.PI) % Math.PI); const near = Math.min(dt, Math.PI - dt) <= Math.PI / 30; return near && Math.abs(Math.abs(offset(k)) - Math.abs(offset(peak))) <= Math.min(width, height) * 0.03; });
    if (!dup) kept.push(peak);
    if (kept.length >= max) break;
  }
  return kept;
}

/** Where a line crosses the horizontal through y (vertical-ish lines) or the vertical through x (horizontal-ish). */
const xAt = (l: SurfaceLine, y: number) => (l.rho - y * Math.sin(l.theta)) / Math.cos(l.theta);
const yAt = (l: SurfaceLine, x: number) => (l.rho - x * Math.cos(l.theta)) / Math.sin(l.theta);

function intersect(a: SurfaceLine, b: SurfaceLine): [number, number] | null {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-9) return null;
  return [(a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det, (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det];
}

export type Surface = { quad: Quad; sides: { left: number; right: number; top: number; bottom: number } };

/**
 * The flat surface around (cx, cy): a quad in the frame's pixel units whose
 * sides are the strongest edges found left, right, above and below the point
 * within the search window (fractions of the frame). Null when a side has no
 * edge worth trusting. `sides` are each side's votes, for the UI to grade.
 */
export function findSurfaceQuad(gray: Gray, cx: number, cy: number, { searchX = 0.42, searchY = 0.3, threshold = 24, minGap = 0.03 }: { searchX?: number; searchY?: number; threshold?: number; minGap?: number } = {}): Surface | null {
  const { width, height } = gray;
  const x0 = Math.round(cx - searchX * width), x1 = Math.round(cx + searchX * width);
  const y0 = Math.round(cy - searchY * height), y1 = Math.round(cy + searchY * height);
  const points = edges(gray, x0, y0, x1, y1, threshold);
  if (points.length < 40) return null;
  const lines = houghLines(points, width, height, { minVotes: Math.round(Math.min(width, height) * 0.08) });
  const verticalish = lines.filter((l) => l.theta < Math.PI / 6 || l.theta > Math.PI - Math.PI / 6);
  const horizontalish = lines.filter((l) => Math.abs(l.theta - Math.PI / 2) < Math.PI / 5);
  const gapX = minGap * width, gapY = minGap * height;
  const left = verticalish.filter((l) => xAt(l, cy) < cx - gapX).sort((a, b) => b.votes - a.votes)[0];
  const right = verticalish.filter((l) => xAt(l, cy) > cx + gapX).sort((a, b) => b.votes - a.votes)[0];
  const top = horizontalish.filter((l) => yAt(l, cx) < cy - gapY).sort((a, b) => b.votes - a.votes)[0];
  const bottom = horizontalish.filter((l) => yAt(l, cx) > cy + gapY).sort((a, b) => b.votes - a.votes)[0];
  if (!left || !right || !top || !bottom) return null;
  const tl = intersect(left, top), tr = intersect(right, top), br = intersect(right, bottom), bl = intersect(left, bottom);
  if (!tl || !tr || !br || !bl) return null;
  const quad = [...tl, ...tr, ...br, ...bl] as Quad;
  // Sanity: a convex quad of a usable size, not the whole frame.
  const w = Math.min(tr[0] - tl[0], br[0] - bl[0]), h = Math.min(bl[1] - tl[1], br[1] - tr[1]);
  if (w < width * 0.12 || h < height * 0.04 || w > width * 1.2 || h > height * 0.9) return null;
  return { quad, sides: { left: left.votes, right: right.votes, top: top.votes, bottom: bottom.votes } };
}
