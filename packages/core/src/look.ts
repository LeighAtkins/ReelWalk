/**
 * One coherent look across clips from different cameras and creators
 * (ADR 0070). A reel built from three creators' footage, each graded "warm"
 * or "cool" from a preset, still jumps in colour at every cut: the presets
 * add the same cast to pictures that did not start alike. Matching fixes the
 * start: every clip's colour statistics are moved onto a reference clip's,
 * and the preset grades then sit on top of footage that already agrees.
 *
 * The match is Reinhard-style colour transfer (mean and standard deviation
 * per channel) in BT.601 YUV. YUV is a linear map of RGB, so the per-channel
 * affine match composes into one 3×3 matrix and offset in RGB, which is
 * exactly what an SVG `feColorMatrix` (and so a CSS filter) can apply. The
 * preview and the worker therefore draw the same picture with no shader and
 * no per-pixel work. Y carries exposure and contrast, U and V carry the
 * cast, so matching their means is also a white balance.
 *
 * Pure: the measurements come in (from a canvas in the browser or a decoded
 * poster on the server), the transform goes out.
 */
import { z } from "zod";
import type { Clip, Timeline } from "./timeline";

/** Mean and standard deviation of Y, U and V over a clip's sampled frames, sRGB 0..1 units. */
export const colorStatsSchema = z.object({
  mean: z.array(z.number().min(-1).max(2)).length(3),
  std: z.array(z.number().min(0).max(2)).length(3),
});
export type ColorStats = z.infer<typeof colorStatsSchema>;

/** A 3×3 matrix (row-major, RGB in, RGB out) and an offset, in sRGB 0..1 units: out = m · rgb + o. */
export const colorMatchSchema = z.object({
  m: z.array(z.number().min(-8).max(8)).length(9),
  o: z.array(z.number().min(-4).max(4)).length(3),
});
export type ColorMatch = z.infer<typeof colorMatchSchema>;

/** The reel's look: which clip the others are matched to, and how far (0 leaves them, 1 matches fully). */
export const lookSchema = z.object({
  referenceClipId: z.string().min(1),
  strength: z.number().min(0).max(1).default(1),
});
export type Look = z.infer<typeof lookSchema>;

/** Gains outside this range mean a near-flat clip (a white wall, a black frame) and would only amplify noise. */
export const GAIN_MIN = 0.5;
export const GAIN_MAX = 2;

/** Frames per clip the editor reads when matching. */
export const LOOK_SAMPLE_FRAMES = 3;

// BT.601 full-range RGB → YUV and back.
const TO_YUV = [0.299, 0.587, 0.114, -0.14713, -0.28886, 0.436, 0.615, -0.51499, -0.10001];
const TO_RGB = [1, 0, 1.13983, 1, -0.39465, -0.5806, 1, 2.03211, 0];

const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

function mul3(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return out;
}

function apply3(m: readonly number[], v: readonly number[]): [number, number, number] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export const IDENTITY_MATCH: ColorMatch = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] };

export function isIdentityMatch(match: ColorMatch | null | undefined, tolerance = 0.002): boolean {
  if (!match) return true;
  return match.m.every((value, i) => Math.abs(value - IDENTITY_MATCH.m[i]) < tolerance) && match.o.every((value) => Math.abs(value) < tolerance);
}

/**
 * Colour statistics of an RGBA buffer (a canvas's `getImageData`, or raw
 * pixels from an image decoder). `step` reads every n-th pixel: 3 frames of
 * a 96×170 sample at step 1 are plenty; a 1080×1920 poster at step 4 is quick.
 * Transparent pixels (a letterboxed frame's margins) are skipped.
 */
export function colorStatsFromRgba(data: ArrayLike<number>, width: number, height: number, step = 1): ColorStats {
  const sum = [0, 0, 0], sq = [0, 0, 0];
  let n = 0;
  const stride = Math.max(1, Math.floor(step));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const yuv = apply3(TO_YUV, [r, g, b]);
      for (let c = 0; c < 3; c++) { sum[c] += yuv[c]; sq[c] += yuv[c] * yuv[c]; }
      n++;
    }
  }
  if (n === 0) return { mean: [0, 0, 0], std: [0, 0, 0] };
  const mean = sum.map((value) => value / n);
  const std = sq.map((value, c) => Math.sqrt(Math.max(0, value / n - mean[c] * mean[c])));
  return { mean: mean.map((v) => round(v)), std: std.map((v) => round(v)) };
}

/** Pools the statistics of several frames of one clip (equal weight per frame). */
export function mergeColorStats(frames: readonly ColorStats[]): ColorStats | null {
  const list = frames.filter((frame) => frame.std.some((value) => value > 0) || frame.mean.some((value) => value !== 0));
  if (list.length === 0) return null;
  const mean = [0, 1, 2].map((c) => list.reduce((acc, frame) => acc + frame.mean[c], 0) / list.length);
  const variance = [0, 1, 2].map((c) => list.reduce((acc, frame) => acc + frame.std[c] ** 2 + (frame.mean[c] - mean[c]) ** 2, 0) / list.length);
  return { mean: mean.map((v) => round(v)), std: variance.map((v) => round(Math.sqrt(v))) };
}

/**
 * The transform that moves a clip with `source` statistics onto `reference`:
 * per YUV channel, y' = (y − μs)·g + μr with g = σr/σs clamped to
 * [GAIN_MIN, GAIN_MAX], composed into RGB. `strength` 0 is the identity, 1 the
 * full match; in between the matrix and offset are interpolated, which is a
 * partial match of both cast and contrast.
 */
export function matchTransform(source: ColorStats, reference: ColorStats, strength = 1): ColorMatch {
  const s = Math.min(1, Math.max(0, strength));
  if (s === 0) return IDENTITY_MATCH;
  const gain = [0, 1, 2].map((c) => {
    const ratio = source.std[c] > 1e-4 ? reference.std[c] / source.std[c] : 1;
    return Math.min(GAIN_MAX, Math.max(GAIN_MIN, Number.isFinite(ratio) ? ratio : 1));
  });
  // M = T⁻¹ · diag(g) · T ; o = T⁻¹ · (μr − g∘μs)
  const scaled = TO_YUV.map((value, i) => value * gain[Math.floor(i / 3)]);
  const m = mul3(TO_RGB, scaled);
  const shift = [0, 1, 2].map((c) => reference.mean[c] - gain[c] * source.mean[c]);
  const o = apply3(TO_RGB, shift);
  return {
    m: m.map((value, i) => round(IDENTITY_MATCH.m[i] + s * (value - IDENTITY_MATCH.m[i]))),
    o: o.map((value) => round(s * value)),
  };
}

/** Applies a match to one sRGB pixel (0..1 units), clamped. For tests and for drawing where no filter runs. */
export function applyColorMatch(match: ColorMatch, rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = apply3(match.m, rgb);
  const clamp = (value: number, offset: number) => Math.min(1, Math.max(0, value + offset));
  return [clamp(r, match.o[0]), clamp(g, match.o[1]), clamp(b, match.o[2])];
}

/** Applies a match to a whole RGBA buffer in place (alpha untouched). */
export function applyColorMatchToRgba(match: ColorMatch, data: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = applyColorMatch(match, [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);
    data[i] = Math.round(r * 255); data[i + 1] = Math.round(g * 255); data[i + 2] = Math.round(b * 255);
  }
}

/**
 * The 20 numbers of an SVG `<feColorMatrix type="matrix">`: rows R, G, B, A;
 * columns R, G, B, A, offset. The filter must run with
 * `color-interpolation-filters="sRGB"`, since the statistics were measured on
 * sRGB values; the SVG default (linearRGB) would apply the matrix to linear light.
 */
export function colorMatrixValues(match: ColorMatch): string {
  const { m, o } = match;
  const rows = [
    [m[0], m[1], m[2], 0, o[0]],
    [m[3], m[4], m[5], 0, o[1]],
    [m[6], m[7], m[8], 0, o[2]],
    [0, 0, 0, 1, 0],
  ];
  return rows.map((row) => row.map((value) => round(value, 5)).join(" ")).join(" ");
}

/** The id of a clip's colour-match filter in the composition's DOM. */
export const colorMatchFilterId = (clipId: string) => `cm-${clipId}`;

/** A clip's colour-match CSS filter (`url(#…)`) when it carries a non-identity match. */
export function colorMatchCss(clip: { id: string; colorMatch?: ColorMatch | null }): string | undefined {
  return clip.colorMatch && !isIdentityMatch(clip.colorMatch) ? `url(#${colorMatchFilterId(clip.id)})` : undefined;
}

// ── The command ─────────────────────────────────────────────────

export type MatchLookOptions = {
  /** The clip the others are matched to; absent keeps the reel's current reference; null clears the match. */
  referenceClipId?: string | null;
  /** 0..1; absent keeps the reel's current strength (1 when it has none). */
  strength?: number;
  /** Measured statistics by clip id, written onto those clips. */
  stats?: Record<string, ColorStats>;
};

/**
 * The `matchLook` command (ADR 0070), pure. Writes any given statistics onto
 * the clips, records the reference and strength on the reel, and gives every
 * clip with statistics the transform onto the reference's. The reference
 * itself and clips without statistics carry no transform. The same timeline
 * and options always give the same result, so a strength slider re-runs it
 * freely without reading pixels again.
 */
export function matchLook(timeline: Timeline, options: MatchLookOptions): Timeline {
  const withStats: Clip[] = timeline.clips.map((clip) => {
    const stats = options.stats?.[clip.id];
    return stats ? { ...clip, colorStats: colorStatsSchema.parse(stats) } : clip;
  });
  const referenceClipId = options.referenceClipId === undefined ? timeline.look?.referenceClipId ?? null : options.referenceClipId;
  if (referenceClipId === null) {
    const cleared = withStats.map((clip) => (clip.colorMatch ? stripMatch(clip) : clip));
    const { look: _look, ...rest } = { ...timeline, clips: cleared };
    void _look;
    return rest as Timeline;
  }
  const reference = withStats.find((clip) => clip.id === referenceClipId);
  if (!reference) throw new Error(`There is no clip called ${referenceClipId} in the reel.`);
  if (!reference.colorStats) throw new Error("The reference clip has not been measured yet.");
  const strength = Math.min(1, Math.max(0, options.strength ?? timeline.look?.strength ?? 1));
  const target = reference.colorStats;
  const clips = withStats.map((clip) => {
    if (clip.id === reference.id || !clip.colorStats) return clip.colorMatch ? stripMatch(clip) : clip;
    const match = matchTransform(clip.colorStats, target, strength);
    return isIdentityMatch(match) ? (clip.colorMatch ? stripMatch(clip) : clip) : { ...clip, colorMatch: match };
  });
  return { ...timeline, clips, look: { referenceClipId: reference.id, strength } };
}

function stripMatch(clip: Clip): Clip {
  const { colorMatch: _match, ...rest } = clip;
  void _match;
  return rest as Clip;
}

/** Clips whose look can be matched: flat pictures with pixels to read (360 photos are a camera sweep, not one picture). */
export function matchableClips(timeline: Timeline): Clip[] {
  return timeline.clips.filter((clip) => !clip.pano);
}

/**
 * How far apart two clips' looks are: the root-mean-square of the per-channel
 * mean differences (cast and exposure), 0 for identical statistics. About 0.03
 * is visible at a cut; a "warm" and a "cool" preset on the same picture are 0.05 apart.
 */
export function lookDistance(a: ColorStats, b: ColorStats): number {
  const d = [0, 1, 2].map((c) => (a.mean[c] - b.mean[c]) ** 2);
  return round(Math.sqrt((d[0] + d[1] + d[2]) / 3));
}
