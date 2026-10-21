/**
 * Following a tapped object through a shot by its own pixels (ADR 0051).
 *
 * A tap is stored at the pin's first frame. Carrying it with the title's
 * wall homography is right for a mullion on the wall and wrong for a plant
 * on a table in front of it during a pan: the plant moves with parallax, not
 * with the wall. Here the tap's neighbourhood on the reference frame is a
 * template, and on each frame it is found again by normalised cross
 * correlation in a window around where the wall homography predicts it.
 *
 * Deterministic and random-access: the answer for frame n depends only on
 * the reference frame, frame n, the tap and the prediction, never on which
 * frames were tracked before. That is what lets parallel render pages,
 * scrubbing and export agree. The price is no template update, so an object
 * that turns or changes size a lot drifts out of the score threshold, and the
 * tap falls back to the homography with status `lost`.
 */

export type Gray = { data: Float32Array; width: number; height: number };
export type Point = { x: number; y: number };
export type TrackStatus = "tracked" | "lost" | "flat" | "edge";
export type TrackResult = Point & { score: number; status: TrackStatus };

/** In pixels of the working frame (540×960). Part of MATTE_VERSION: change one, the version changes. */
export const TRACK_PARAMS = {
  /** Template half-size: a 21×21 patch around the tap. */
  half: 10,
  /** Search radius around the prediction. */
  radius: 40,
  /** Coarse search stride; refined to one pixel, then a parabola for sub-pixel. */
  step: 2,
  /** Below this correlation the object is called lost. */
  minScore: 0.7,
  /** A template flatter than this (luminance standard deviation) cannot be matched: a blank wall. */
  minStd: 0.02,
} as const;

type Params = typeof TRACK_PARAMS;

function templateAt(ref: Gray, cx: number, cy: number, half: number): { values: Float32Array; mean: number; std: number } | null {
  if (cx - half < 0 || cy - half < 0 || cx + half >= ref.width || cy + half >= ref.height) return null;
  const size = 2 * half + 1;
  const values = new Float32Array(size * size);
  let sum = 0;
  for (let dy = -half, k = 0; dy <= half; dy++) for (let dx = -half; dx <= half; dx++, k++) { const v = ref.data[(cy + dy) * ref.width + cx + dx]; values[k] = v; sum += v; }
  const mean = sum / values.length;
  let sq = 0;
  for (let k = 0; k < values.length; k++) { values[k] -= mean; sq += values[k] * values[k]; }
  return { values, mean, std: Math.sqrt(sq / values.length) };
}

/** Normalised cross correlation of the zero-mean template with `cur` centred at (cx, cy); -1 when the window leaves the frame. */
function ncc(cur: Gray, cx: number, cy: number, half: number, template: Float32Array, templateNorm: number): number {
  if (cx - half < 0 || cy - half < 0 || cx + half >= cur.width || cy + half >= cur.height) return -1;
  let sum = 0, sumSq = 0, cross = 0;
  for (let dy = -half, k = 0; dy <= half; dy++) {
    const row = (cy + dy) * cur.width + cx;
    for (let dx = -half; dx <= half; dx++, k++) { const v = cur.data[row + dx]; sum += v; sumSq += v * v; cross += template[k] * v; }
  }
  const n = template.length;
  const variance = sumSq - (sum * sum) / n;
  if (variance <= 1e-9) return 0;
  // The template is zero-mean, so Σ t·(v − mean v) = Σ t·v.
  return cross / (templateNorm * Math.sqrt(variance));
}

/** The vertex offset of the parabola through three samples, in [-0.5, 0.5]. */
function parabola(left: number, mid: number, right: number): number {
  const denom = left - 2 * mid + right;
  if (denom >= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom));
}

/**
 * Where the patch around `refPoint` on `ref` is on `cur`, searched around `prior`
 * (both in pixels). On a weak match, a flat template or a tap at the frame's
 * edge, returns `prior` with the reason.
 */
export function trackPoint(ref: Gray, refPoint: Point, cur: Gray, prior: Point, params: Params = TRACK_PARAMS): TrackResult {
  const { half, radius, step, minScore, minStd } = params;
  const lost = (status: TrackStatus, score = 0): TrackResult => ({ x: prior.x, y: prior.y, score, status });
  const template = templateAt(ref, Math.round(refPoint.x), Math.round(refPoint.y), half);
  if (!template) return lost("edge");
  if (template.std < minStd) return lost("flat");
  const norm = template.std * Math.sqrt(template.values.length);
  const px = Math.round(prior.x), py = Math.round(prior.y);
  // Coarse: every `step` pixels across the window, scanned in a fixed order; ties keep the first.
  let best = -2, bx = px, by = py;
  for (let dy = -radius; dy <= radius; dy += step) for (let dx = -radius; dx <= radius; dx += step) {
    const score = ncc(cur, px + dx, py + dy, half, template.values, norm);
    if (score > best) { best = score; bx = px + dx; by = py + dy; }
  }
  // Fine: every pixel around the coarse peak.
  const cx = bx, cy = by;
  for (let dy = -(step - 1); dy <= step - 1; dy++) for (let dx = -(step - 1); dx <= step - 1; dx++) {
    if (!dx && !dy) continue;
    const score = ncc(cur, cx + dx, cy + dy, half, template.values, norm);
    if (score > best) { best = score; bx = cx + dx; by = cy + dy; }
  }
  // A stride with no filtered pyramid can step over the peak of a fine texture (a one-pixel
  // shift scored 0.145 with an exact match in the window): before calling it lost, try every pixel.
  if (best < minScore) {
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const score = ncc(cur, px + dx, py + dy, half, template.values, norm);
      if (score > best) { best = score; bx = px + dx; by = py + dy; }
    }
  }
  if (best < minScore) return lost("lost", best);
  const ox = parabola(ncc(cur, bx - 1, by, half, template.values, norm), best, ncc(cur, bx + 1, by, half, template.values, norm));
  const oy = parabola(ncc(cur, bx, by - 1, half, template.values, norm), best, ncc(cur, bx, by + 1, half, template.values, norm));
  // The tap need not be the patch centre's integer pixel: keep its sub-pixel offset.
  return { x: bx + ox + (refPoint.x - Math.round(refPoint.x)), y: by + oy + (refPoint.y - Math.round(refPoint.y)), score: best, status: "tracked" };
}
