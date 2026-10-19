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
