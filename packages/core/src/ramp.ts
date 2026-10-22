/**
 * Speed ramps (ADR 0067): how a clip's playback is shaped inside its window.
 *
 * A ramp is a curve of relative speed over the clip's on-screen time, `p` 0
 * (the first frame) to 1 (the cut). It redistributes the clip's source inside
 * the same reel length: the clip still plays `sourceStartMs..sourceEndMs` in
 * `clipDurationMs` at a mean of `clip.speed`, so every length, start and
 * beat the editor knows stays exact. Only where the clip is at a given frame
 * changes: slow at first, fast into the cut, or the other way round.
 *
 * Pure maths, no DOM, so the composition, the editor's frame service and the
 * pacing engine read one function.
 */
import { z } from "zod";

export const RAMP_PRESETS = ["slow-in", "slow-out", "into-cut", "hold-snap", "hit"] as const;
export type RampPreset = (typeof RAMP_PRESETS)[number];

/** One point of the curve: at `p` of the clip's on-screen time, play at `v` times the clip's mean speed (before normalising). */
export const rampKeySchema = z.object({ p: z.number().min(0).max(1), v: z.number().min(0.1).max(8) });
export const rampSchema = z
  .object({
    /** The preset the keys came from, for the UI; "custom" when the keys were written by hand or an agent. */
    preset: z.enum([...RAMP_PRESETS, "custom"]),
    /** 2 to 12 keys, `p` ascending, the first at 0 and the last at 1. Speed is linear between keys. */
    keys: z.array(rampKeySchema).min(2).max(12),
  })
  .refine((ramp) => ramp.keys[0].p === 0 && ramp.keys[ramp.keys.length - 1].p === 1 && ramp.keys.every((key, i) => i === 0 || key.p >= ramp.keys[i - 1].p), {
    message: "Ramp keys must run from p 0 to p 1 in order",
  });
export type Ramp = z.infer<typeof rampSchema>;
export type RampKey = z.infer<typeof rampKeySchema>;

/** The presets' curves (relative speeds; the mean is normalised away, so only the shape matters). */
const PRESET_KEYS: Record<RampPreset, RampKey[]> = {
  // Eases in from slow: the shot settles before it plays at speed.
  "slow-in": [{ p: 0, v: 0.45 }, { p: 0.3, v: 1 }, { p: 1, v: 1 }],
  // Eases out: the last third slows, a reveal.
  "slow-out": [{ p: 0, v: 1 }, { p: 0.7, v: 1 }, { p: 1, v: 0.45 }],
  // Ramp into the cut: a steady hold, then the last 40% accelerates so the cut lands on the fast part.
  "into-cut": [{ p: 0, v: 0.8 }, { p: 0.6, v: 0.8 }, { p: 0.85, v: 2.2 }, { p: 1, v: 3 }],
  // Hold, then snap: the speed jumps over four percent of the clip and stays fast to the cut.
  "hold-snap": [{ p: 0, v: 0.85 }, { p: 0.78, v: 0.85 }, { p: 0.82, v: 3 }, { p: 1, v: 3 }],
  // Hit: fast on frame 0 (motion from the first frame), settling by a third of the way in.
  hit: [{ p: 0, v: 3 }, { p: 0.12, v: 3 }, { p: 0.3, v: 0.9 }, { p: 1, v: 0.9 }],
};

export const RAMP_LABELS: Record<RampPreset, string> = {
  "slow-in": "Slow in",
  "slow-out": "Slow out",
  "into-cut": "Into the cut",
  "hold-snap": "Hold, then snap",
  hit: "Hit",
};

export function rampPreset(preset: RampPreset): Ramp {
  return { preset, keys: PRESET_KEYS[preset].map((key) => ({ ...key })) };
}

/** A ramp whose keys are not a preset's. */
export function customRamp(keys: RampKey[]): Ramp {
  return rampSchema.parse({ preset: "custom", keys });
}

/** The relative speed at `p` (before normalising), linear between keys. */
function rawSpeedAt(keys: readonly RampKey[], p: number): number {
  const t = Math.max(0, Math.min(1, p));
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b.p) {
      const span = b.p - a.p;
      return span <= 0 ? b.v : a.v + ((b.v - a.v) * (t - a.p)) / span;
    }
  }
  return keys[keys.length - 1].v;
}

/** The integral of the raw speed from 0 to each key, and over the whole clip. */
function integrals(keys: readonly RampKey[]): { at: number[]; total: number } {
  const at = [0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    at.push(at[i - 1] + ((a.v + b.v) / 2) * (b.p - a.p));
  }
  return { at, total: at[at.length - 1] || 1 };
}

/**
 * Where in its source the clip is at `p` of its on-screen time, as a fraction
 * 0..1 of the source window. Rises monotonically, 0 at p 0 and 1 at p 1.
 * Without a ramp this is `p` itself.
 */
export function rampWarp(ramp: Ramp | null | undefined, p: number): number {
  if (!ramp) return Math.max(0, Math.min(1, p));
  const t = Math.max(0, Math.min(1, p));
  const { keys } = ramp;
  const { at, total } = integrals(keys);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b.p) {
      const span = b.p - a.p;
      if (span <= 0) return at[i] / total;
      const x = t - a.p;
      const slope = (b.v - a.v) / span;
      return (at[i - 1] + a.v * x + (slope * x * x) / 2) / total;
    }
  }
  return 1;
}

/** The speed at `p` relative to the clip's mean speed: 1 means "as `clip.speed` says", 3 three times it. */
export function rampSpeedAt(ramp: Ramp | null | undefined, p: number): number {
  if (!ramp) return 1;
  return rawSpeedAt(ramp.keys, p) / integrals(ramp.keys).total;
}

/** The inverse of `rampWarp`: at which fraction `p` of its on-screen time the clip shows source fraction `u`. */
export function rampUnwarp(ramp: Ramp | null | undefined, u: number): number {
  const target = Math.max(0, Math.min(1, u));
  if (!ramp) return target;
  const { keys } = ramp;
  const { at, total } = integrals(keys);
  const want = target * total;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (want <= at[i] + 1e-12) {
      const span = b.p - a.p;
      if (span <= 0) return b.p;
      const rest = want - at[i - 1];
      const slope = (b.v - a.v) / span;
      // ½·slope·x² + a.v·x − rest = 0, the root in [0, span].
      const x = Math.abs(slope) < 1e-9 ? rest / a.v : (-a.v + Math.sqrt(Math.max(0, a.v * a.v + 2 * slope * rest))) / slope;
      return a.p + Math.max(0, Math.min(span, x));
    }
  }
  return 1;
}

/** The fastest relative speed anywhere on the ramp (how far the shot snaps). */
export function rampPeak(ramp: Ramp | null | undefined): number {
  if (!ramp) return 1;
  const total = integrals(ramp.keys).total;
  return Math.max(...ramp.keys.map((key) => key.v)) / total;
}

/**
 * How loud a clip's own sound plays at relative speed `rel` (ADR 0067): full
 * near its mean speed, fading to silence as the ramp pulls the picture far
 * from it, so a ramp never plays chipmunk or dragging audio. 1 without a ramp.
 */
export function rampGain(rel: number): number {
  const off = Math.abs(rel - 1);
  if (off <= 0.25) return 1;
  if (off >= 0.75) return 0;
  return 1 - (off - 0.25) / 0.5;
}

/**
 * The ramp of the piece `[p0, p1]` of a ramped clip, re-stretched over 0..1:
 * splitting a ramped clip gives each piece the part of the curve it played.
 * Null for a piece of a clip with no ramp.
 */
export function sliceRamp(ramp: Ramp | null | undefined, p0: number, p1: number): Ramp | null {
  if (!ramp || p1 <= p0) return null;
  const inside = ramp.keys.filter((key) => key.p > p0 && key.p < p1);
  const keys: RampKey[] = [
    { p: 0, v: rawSpeedAt(ramp.keys, p0) },
    ...inside.map((key) => ({ p: (key.p - p0) / (p1 - p0), v: key.v })),
    { p: 1, v: rawSpeedAt(ramp.keys, p1) },
  ];
  // A flat piece (every key within a hair of the same speed) is no ramp at all.
  const speeds = keys.map((key) => key.v);
  if (Math.max(...speeds) - Math.min(...speeds) < 0.02) return null;
  return { preset: "custom", keys: keys.map((key) => ({ p: round4(key.p), v: round4(key.v) })) };
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** The speed, relative to the mean, across the clip at `n` evenly spaced points, for a strip or a thumb graph. */
export function rampProfile(ramp: Ramp | null | undefined, n = 24): number[] {
  return Array.from({ length: n }, (_, i) => rampSpeedAt(ramp, n > 1 ? i / (n - 1) : 0));
}
