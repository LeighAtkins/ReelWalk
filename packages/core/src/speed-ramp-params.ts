/**
 * The speed-ramp transition's parameters (ADR 0073), apart from the maths in
 * speed-ramp.ts so the clip schema (timeline.ts) can import them without a
 * cycle. zod only.
 */
import { z } from "zod";

export const SPEED_RAMP_LIMITS = {
  durationMs: { min: 200, max: 800 },
  peak: { min: 2, max: 6 },
  blur: { min: 0, max: 1 },
  push: { min: 0, max: 0.2 },
} as const;

export const SPEED_RAMP_DIRECTIONS = ["auto", "none", "left", "right", "up", "down", "zoom"] as const;

/** The widest zoom blur (ADR 0074): the stack of copies spans this much scale at `blur` 1 and the peak (0.2 = the outer copy is 20 % larger). */
export const SPEED_RAMP_ZOOM_SPREAD = 0.2;

/**
 * Where the blur streaks: "auto" follows the footage (each side of the cut by what its own shot does: a forward
 * move streaks from the middle, a pan along the pan; without a reading it follows the whip direction), a named
 * axis, "zoom" (streaks radiate from the frame's middle, or from the shot's vanishing point when the footage has
 * one), an angle in degrees (0 = horizontal), or "none" (no blur).
 */
export const speedRampDirectionSchema = z.union([z.enum(SPEED_RAMP_DIRECTIONS), z.number().min(0).max(360)]);

export const speedRampSchema = z.object({
  /** The whole transition, split evenly: the outgoing tail and the incoming head each take half. */
  durationMs: z.number().min(SPEED_RAMP_LIMITS.durationMs.min).max(SPEED_RAMP_LIMITS.durationMs.max).default(500),
  /** The speed at the cut, as a multiple of the clips' own. */
  peak: z.number().min(SPEED_RAMP_LIMITS.peak.min).max(SPEED_RAMP_LIMITS.peak.max).default(4),
  /** Motion blur strength at the peak, 0 (none) to 1. */
  blur: z.number().min(SPEED_RAMP_LIMITS.blur.min).max(SPEED_RAMP_LIMITS.blur.max).default(0.6),
  /** Extra scale at the peak: 0.08 pushes in by 8 %. */
  push: z.number().min(SPEED_RAMP_LIMITS.push.min).max(SPEED_RAMP_LIMITS.push.max).default(0.08),
  direction: speedRampDirectionSchema.default("auto"),
  /**
   * When both sides of the cut are zoom blurs, the radial burst is centred on one point through the cut (where the
   * footage's vanishing points agree) instead of jumping from the outgoing shot's to the incoming one's. Absent or
   * true: shared. False: each side keeps its own focus (ADR 0074).
   */
  shareFocus: z.boolean().optional(),
  /** Placed by Pace's "Speed-ramp the strong cuts", so switching that off takes back only what it placed. Absent: the studio's own. */
  auto: z.boolean().optional(),
});
export type SpeedRampParams = z.infer<typeof speedRampSchema>;
export type SpeedRampDirection = z.infer<typeof speedRampDirectionSchema>;

/** The two presets the transition sheet offers. */
export const SPEED_RAMP_PRESETS = {
  soft: { durationMs: 400, peak: 3, blur: 0.5, push: 0.06, direction: "auto" },
  punch: { durationMs: 300, peak: 5, blur: 0.75, push: 0.1, direction: "auto" },
} as const satisfies Record<string, SpeedRampParams>;
export type SpeedRampPreset = keyof typeof SPEED_RAMP_PRESETS;
export const SPEED_RAMP_PRESET_LABELS: Record<SpeedRampPreset, string> = { soft: "Soft", punch: "Punch" };

/** The defaults, every field set. */
export const defaultSpeedRamp = (): SpeedRampParams => speedRampSchema.parse({});

/** Parses and fills in defaults; throws (with the field) for a value out of range. */
export function parseSpeedRamp(value: unknown): SpeedRampParams {
  return speedRampSchema.parse(value ?? {});
}

/** The one-knob intensity (0 gentle .. 1 hard) as parameters: soft sits at 0.25 and punch at 0.75. Blur and push follow the peak. */
export function speedRampAtIntensity(intensity: number, base: Pick<SpeedRampParams, "direction"> = { direction: "auto" }): SpeedRampParams {
  const i = Math.min(1, Math.max(0, intensity));
  return {
    durationMs: Math.round(450 - 200 * i),
    peak: round2(2 + 4 * i),
    blur: round2(0.3 + 0.6 * i),
    push: round2(0.04 + 0.08 * i),
    direction: base.direction,
  };
}

/** Where the parameters sit on the intensity knob, from the peak. */
export function intensityOfSpeedRamp(params: Pick<SpeedRampParams, "peak">): number {
  return Math.min(1, Math.max(0, (params.peak - 2) / 4));
}

/** Which preset the parameters are (to the figures the sheet shows), or null for a custom set. */
export function speedRampPresetOf(params: SpeedRampParams): SpeedRampPreset | null {
  for (const [name, preset] of Object.entries(SPEED_RAMP_PRESETS) as [SpeedRampPreset, SpeedRampParams][]) {
    if (params.peak === preset.peak && params.durationMs === preset.durationMs && params.blur === preset.blur && params.push === preset.push) return name;
  }
  return null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

