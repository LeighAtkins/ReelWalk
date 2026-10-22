/**
 * Eased camera moves (ADR 0067): keyframed scale and position over a clip,
 * with easing, in place of the linear Ken Burns presets of `motion`
 * (`cameraMoveAt`, kept as it was for saved reels).
 *
 * A move is keys over `p`, the clip's on-screen time 0..1: scale about the
 * centre, and x/y as a percentage of the frame the picture is shifted. Each
 * key names how the move eases into it. The composition, the editor's frame
 * service and the critic read one function, `cameraKeysAt`.
 */
import { z } from "zod";

export const CAMERA_PRESETS = ["push", "push-settle", "drift", "snap"] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];
export const CAMERA_EASES = ["linear", "in", "out", "in-out", "snap"] as const;
export type CameraEase = (typeof CAMERA_EASES)[number];

/** Largest scale a move may reach: the same crop limit as the clip's zoom (twice). */
export const CAMERA_SCALE_MAX = 2;
/** Furthest a move may shift the picture, percent of the frame. */
export const CAMERA_SHIFT_MAX = 20;

export const cameraKeySchema = z.object({
  p: z.number().min(0).max(1),
  scale: z.number().min(1).max(CAMERA_SCALE_MAX),
  /** Shift of the picture, percent of the frame width (x) and height (y); positive moves it right and down. */
  x: z.number().min(-CAMERA_SHIFT_MAX).max(CAMERA_SHIFT_MAX).default(0),
  y: z.number().min(-CAMERA_SHIFT_MAX).max(CAMERA_SHIFT_MAX).default(0),
  /** How the move eases into this key from the one before; ignored on the first key. */
  ease: z.enum(CAMERA_EASES).default("in-out"),
});
export const cameraSchema = z
  .object({
    preset: z.enum([...CAMERA_PRESETS, "custom"]),
    keys: z.array(cameraKeySchema).min(2).max(8),
  })
  .refine((camera) => camera.keys[0].p === 0 && camera.keys[camera.keys.length - 1].p === 1 && camera.keys.every((key, i) => i === 0 || key.p >= camera.keys[i - 1].p), {
    message: "Camera keys must run from p 0 to p 1 in order",
  });
export type Camera = z.infer<typeof cameraSchema>;
export type CameraKey = z.infer<typeof cameraKeySchema>;
export type CameraMove = { scale: number; x: number; y: number };

export const CAMERA_LABELS: Record<CameraPreset, string> = {
  push: "Slow push",
  "push-settle": "Push, then settle",
  drift: "Drift",
  snap: "Snap zoom",
};

const PRESET_KEYS: Record<CameraPreset, CameraKey[]> = {
  // A slow, even push: moving from the first frame to the last.
  push: [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1.12, x: 0, y: 0, ease: "linear" }],
  // Pushes in quickly, overshoots a little, settles.
  "push-settle": [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 0.55, scale: 1.15, x: 0, y: 0, ease: "out" }, { p: 1, scale: 1.12, x: 0, y: 0, ease: "in-out" }],
  // A lateral drift across a slightly closer picture.
  drift: [{ p: 0, scale: 1.1, x: -3, y: 1, ease: "linear" }, { p: 1, scale: 1.1, x: 3, y: -1, ease: "linear" }],
  // Snaps closer over the first few frames (on the beat the cut is on), then holds.
  snap: [{ p: 0, scale: 1, x: 0, y: 0, ease: "snap" }, { p: 0.1, scale: 1.12, x: 0, y: 0, ease: "snap" }, { p: 1, scale: 1.12, x: 0, y: 0, ease: "linear" }],
};

export function cameraPreset(preset: CameraPreset): Camera {
  return { preset, keys: PRESET_KEYS[preset].map((key) => ({ ...key })) };
}

export function customCamera(keys: CameraKey[]): Camera {
  return cameraSchema.parse({ preset: "custom", keys });
}

export function easeValue(ease: CameraEase, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (ease) {
    case "in": return x * x;
    case "out": return 1 - (1 - x) * (1 - x);
    case "in-out": return x * x * (3 - 2 * x);
    case "snap": return 1 - Math.pow(1 - x, 5);
    default: return x;
  }
}

/** The pose at `p` of the move: the key before and after, eased between them. */
export function cameraKeysAt(camera: Camera, p: number): CameraMove {
  const t = Math.max(0, Math.min(1, p));
  const { keys } = camera;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b.p) {
      const span = b.p - a.p;
      const mix = span <= 0 ? 1 : easeValue(b.ease, (t - a.p) / span);
      return { scale: a.scale + (b.scale - a.scale) * mix, x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix };
    }
  }
  const last = keys[keys.length - 1];
  return { scale: last.scale, x: last.x, y: last.y };
}

/**
 * Motion on frame 0 (ADR 0067): the opening shot's move is read from a tenth
 * of the way in, so its first frame is already moving rather than easing out
 * of a standstill. `p` 0..1 becomes 0.1..1.
 */
export const OPENING_PHASE = 0.1;
export function openingProgress(progress: number): number {
  return OPENING_PHASE + (1 - OPENING_PHASE) * Math.max(0, Math.min(1, progress));
}

/**
 * True when the move eases out of a standstill: over the first two percent of
 * the clip it covers less than a quarter of what an even move would (an "in"
 * or "in-out" first segment). The presets all move from frame 0; a hand-made
 * move may not, and the opening shot then reads it from `openingProgress`.
 */
export function cameraStillAtStart(camera: Camera): boolean {
  const a = cameraKeysAt(camera, 0), b = cameraKeysAt(camera, 0.02), z = cameraKeysAt(camera, 1);
  const moved = Math.abs(a.scale - b.scale) + Math.abs(a.x - b.x) / 100 + Math.abs(a.y - b.y) / 100;
  const whole = Math.abs(a.scale - z.scale) + Math.abs(a.x - z.x) / 100 + Math.abs(a.y - z.y) / 100;
  return whole > 1e-6 && moved < whole * 0.02 * 0.25;
}
