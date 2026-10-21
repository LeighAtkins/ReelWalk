/**
 * The tracking loop `trackTextPath` ran before ADR 0052, lifted out of
 * apps/web/components/editor/frame-analysis.ts (surface-pin branch) so the
 * benchmark can compare against it on the same frames. Kept as close to the
 * original as a pure function allows: the same constants scaled to the frame
 * width, the same region-borrowing cascade, the same hold-three-then-lost rule
 * and the same grade.
 */
import { planePoints, trackPlane, type Gray, type Quad } from "../../src";

export type LegacyFrame = { quad: Quad; o: number };
export type LegacyResult = { frames: LegacyFrame[]; grade: "good" | "weak" | "lost"; lostAt: number | null; points: number } | null;

export function legacyTrack(frames: Gray[], surface: Quad): LegacyResult {
  const W = frames[0].width, H = frames[0].height;
  let prev = frames[0];
  const radius = Math.round(W * 0.03), range = Math.round(W * 0.06), tolerance = W * 0.006;
  const margin = radius + 1;
  let quad: Quad = surface;
  const xs = [surface[0], surface[2], surface[4], surface[6]], ys = [surface[1], surface[3], surface[5], surface[7]];
  const grow = (k: number): Quad => { const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); const gx = (x1 - x0) * k, gy = (y1 - y0) * k; return [x0 - gx, y0 - gy, x1 + gx, y0 - gy, x1 + gx, y1 + gy, x0 - gx, y1 + gy]; };
  let points = planePoints(prev, grow(0.08), { grid: 9, radius, minEnergy: 8 });
  if (points.length < 6) points = planePoints(prev, grow(0.3), { grid: 9, radius, minEnergy: 8 });
  if (points.length < 8) points = [...points, ...planePoints(prev, grow(1.0), { grid: 11, radius, minEnergy: 8 }).filter(c => !points.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < radius))];
  if (points.length < 8) points = [...points, ...planePoints(prev, [margin, margin, W - margin, margin, W - margin, H - margin, margin, H - margin], { grid: 12, radius, minEnergy: 8 }).filter(c => !points.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < radius))];
  if (points.length < 4) return null;
  const initial = points.length;
  const out: LegacyFrame[] = [{ quad, o: 1 }];
  let lostAt: number | null = null, misses = 0, inlierSum = 0, steps = 0, held = 0;
  const inFrame = (p: [number, number]) => p[0] >= margin && p[1] >= margin && p[0] < W - margin && p[1] < H - margin;
  const fadeFrames = Math.max(1, Math.round((frames.length - 1) * 0.1));
  for (let k = 1; k < frames.length; k++) {
    const next = frames[k];
    if (lostAt === null) {
      steps++;
      const moved = trackPlane(prev, next, points.filter(inFrame), quad, { radius, range, tolerance, model: "affine" });
      if (!moved) {
        held++;
        if (++misses >= 3) lostAt = k;
      } else {
        misses = 0; inlierSum += moved.inliers;
        quad = moved.quad;
        points = moved.points.filter(inFrame);
        if (points.length < 8) points = [...points, ...planePoints(next, grow(1.0), { grid: 11, radius, minEnergy: 8 }).filter(c => !points.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < radius))];
      }
    }
    out.push({ quad, o: lostAt === null ? 1 : Math.max(0, 1 - (k - lostAt) / fadeFrames) });
    prev = next;
  }
  const inliers = steps ? Math.round(inlierSum / Math.max(1, steps - held)) : 0;
  const grade = lostAt !== null ? "lost" : held > steps * 0.15 || inliers < 8 ? "weak" : "good";
  return { frames: out, grade, lostAt, points: initial };
}
