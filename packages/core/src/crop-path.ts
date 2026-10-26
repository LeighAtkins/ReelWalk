/**
 * The reframe of a landscape source to 9:16 (ADR 0086): a subject-following crop
 * that never jitters. The worker turns raw attention targets (saliency peak,
 * pulled toward where the motion is going) into a smooth path with
 * `smoothCropPath`; the clip stores it as `clip.reframe`; the shared composition
 * reads `reframeShiftAt` per frame, so the editor preview and the export draw
 * the same crop.
 *
 * Smoothing, in order:
 * 1. Dead band with hysteresis: the held target moves only when the raw target
 *    leaves a band around it, so a saliency peak flickering between two lamps
 *    does not move the camera at all.
 * 2. A critically damped spring (no overshoot) run forward and then backward
 *    over the held target and averaged, which cancels the spring's lag: the
 *    camera starts to move a little before the subject does, as an operator's would.
 * 3. A speed limit, so a jump of attention becomes a pan, never a whip.
 * 4. Kept inside the frame: the crop never shows past the picture's edge.
 */
import { z } from "zod";

/** The reel frame, width / height. */
export const REEL_ASPECT = 9 / 16;

export const reframeKeySchema = z.object({
  /** Source ms of the asset (so the path survives trims and moves of the clip). */
  t: z.number().min(0),
  /** Centre of the 9:16 crop, fraction of the source width. */
  x: z.number().min(0).max(1),
});
export type ReframeKey = z.infer<typeof reframeKeySchema>;

/** The clip field: the crop path of a source wider than the reel. Absent: the centred cover crop, as before. */
export const clipReframeSchema = z.object({
  /** Source width / height, so the crop is drawn without reading the video's size. */
  aspect: z.number().min(0.2).max(8),
  keys: z.array(reframeKeySchema).min(1).max(600),
});
export type ClipReframe = z.infer<typeof clipReframeSchema>;

/** Width of the 9:16 crop as a fraction of a source of `aspect` (1 when the source is not wider than the reel). */
export function cropWidthFor(aspect: number, boxAspect = REEL_ASPECT): number {
  return aspect > boxAspect ? boxAspect / aspect : 1;
}

/** The crop centre at source time `t`: eased between keys (smoothstep, so a key is never a corner), held past the ends, kept inside the frame. */
export function reframeCentreAt(reframe: ClipReframe, t: number, boxAspect = REEL_ASPECT): number {
  const half = cropWidthFor(reframe.aspect, boxAspect) / 2;
  const keep = (x: number) => Math.min(1 - half, Math.max(half, x));
  const keys = reframe.keys;
  if (t <= keys[0].t) return keep(keys[0].x);
  const last = keys[keys.length - 1];
  if (t >= last.t) return keep(last.x);
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo], b = keys[hi];
  const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
  // Linear between keys is what the smoother produced (keys are dense); a light ease rounds the joins.
  const eased = f + (f * f * (3 - 2 * f) - f) * 0.5;
  return keep(a.x + (b.x - a.x) * eased);
}

/**
 * How far to slide a cover-fitted picture so the crop is centred on the reframe at source time `t`, as a percentage of
 * the box width (positive moves the picture right, for CSS `translateX(%)`). 0 for a source that is not wider than the box.
 */
export function reframeShiftAt(reframe: ClipReframe, t: number, boxAspect = REEL_ASPECT): number {
  if (reframe.aspect <= boxAspect) return 0;
  const scale = reframe.aspect / boxAspect; // the picture's width in box widths
  return (0.5 - reframeCentreAt(reframe, t, boxAspect)) * scale * 100;
}

export type CropTarget = { t: number; x: number; /** How much to trust this target, 0..1 (a weak saliency peak pulls less). */ weight?: number };

export type SmoothOptions = {
  /** Crop width, source fractions (the crop is kept inside the frame). */
  cropWidth: number;
  /** The band (source widths) the raw target must leave before the held target moves. */
  deadband?: number;
  /** Spring natural frequency, rad/s: 2 settles in about 2 s. */
  omega?: number;
  /** Fastest the crop may move, source widths a second. */
  maxSpeed?: number;
  /** Key spacing of the output, ms. */
  keyEveryMs?: number;
  /** Integration step, ms. */
  stepMs?: number;
};

/**
 * A smooth crop path through `targets` (source time ms, crop centre x as a source fraction), as keys every
 * `keyEveryMs` from the first target to the last. Weak targets are first pulled toward the frame centre, so a frame
 * with nothing salient holds still rather than wandering.
 */
export function smoothCropPath(targets: readonly CropTarget[], options: SmoothOptions): ReframeKey[] {
  const { cropWidth, deadband = 0.06, omega = 2.2, maxSpeed = 0.12, keyEveryMs = 500, stepMs = 1000 / 30 } = options;
  if (!targets.length) return [];
  const half = Math.min(0.5, cropWidth / 2);
  const keep = (x: number) => Math.min(1 - half, Math.max(half, x));
  const sorted = [...targets].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t, t1 = sorted[sorted.length - 1].t;
  if (t1 - t0 < stepMs) return [{ t: Math.round(t0), x: round4(keep(sorted[0].x)) }];

  // The raw target on the integration grid: weighted toward the centre where weak, then linear between targets.
  const pulled = sorted.map((p) => ({ t: p.t, x: 0.5 + (p.x - 0.5) * Math.min(1, Math.max(0, p.weight ?? 1)) }));
  const steps = Math.ceil((t1 - t0) / stepMs) + 1;
  const raw = new Float64Array(steps);
  for (let i = 0, j = 0; i < steps; i++) {
    const t = Math.min(t1, t0 + i * stepMs);
    while (j < pulled.length - 2 && pulled[j + 1].t < t) j++;
    const a = pulled[j], b = pulled[Math.min(pulled.length - 1, j + 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    raw[i] = keep(a.x + (b.x - a.x) * f);
  }

  // 1. Dead band with hysteresis.
  const held = new Float64Array(steps);
  let hold = raw[0];
  for (let i = 0; i < steps; i++) {
    if (Math.abs(raw[i] - hold) > deadband) hold = raw[i] - Math.sign(raw[i] - hold) * deadband * 0.5;
    held[i] = hold;
  }

  // 2. Critically damped spring, forward and backward, averaged (zero phase).
  const dt = stepMs / 1000;
  const spring = (input: Float64Array, reverse: boolean): Float64Array => {
    const out = new Float64Array(steps);
    let x = input[reverse ? steps - 1 : 0], v = 0;
    for (let k = 0; k < steps; k++) {
      const i = reverse ? steps - 1 - k : k;
      // Semi-implicit Euler on x'' = ω²(target − x) − 2ω x'.
      v += (omega * omega * (input[i] - x) - 2 * omega * v) * dt;
      x += v * dt;
      out[i] = x;
    }
    return out;
  };
  const forward = spring(held, false), backward = spring(held, true);
  const smooth = new Float64Array(steps);
  for (let i = 0; i < steps; i++) smooth[i] = (forward[i] + backward[i]) / 2;

  // 3. Speed limit, both ways so it stays symmetric; 4. inside the frame.
  const maxStep = maxSpeed * dt;
  for (let i = 1; i < steps; i++) smooth[i] = smooth[i - 1] + Math.max(-maxStep, Math.min(maxStep, smooth[i] - smooth[i - 1]));
  for (let i = steps - 2; i >= 0; i--) smooth[i] = smooth[i + 1] + Math.max(-maxStep, Math.min(maxStep, smooth[i] - smooth[i + 1]));

  const keys: ReframeKey[] = [];
  for (let t = t0; t <= t1 + 1e-6; t += keyEveryMs) keys.push({ t: Math.round(t), x: round4(keep(smooth[Math.min(steps - 1, Math.round((t - t0) / stepMs))])) });
  if (keys[keys.length - 1].t < Math.round(t1)) keys.push({ t: Math.round(t1), x: round4(keep(smooth[steps - 1])) });
  return keys;
}

/** The largest change of crop speed between neighbouring keys, source widths a second squared: the jitter measure tests and the report use. */
export function cropJerk(keys: readonly ReframeKey[]): number {
  let worst = 0;
  for (let i = 2; i < keys.length; i++) {
    const v1 = (keys[i - 1].x - keys[i - 2].x) / ((keys[i - 1].t - keys[i - 2].t) / 1000);
    const v2 = (keys[i].x - keys[i - 1].x) / ((keys[i].t - keys[i - 1].t) / 1000);
    worst = Math.max(worst, Math.abs(v2 - v1) / ((keys[i].t - keys[i - 2].t) / 2000));
  }
  return worst;
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;
