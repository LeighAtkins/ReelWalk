/**
 * Does a title stay on its plane (ADR 0053)? The glyph pixels of a frame (the
 * difference between the frame drawn with the title and without it) are
 * carried back through the plane's homography into the plane's own rectangle.
 * A title painted on a wall keeps the same place in that rectangle on every
 * frame, whatever the camera does; one that walks off its plane does not.
 */
import { applyHomography, homography, invertHomography, type Quad } from "@reelwalk/core";

export type PlaneBox = { left: number; right: number; top: number; bottom: number };

export type AttachmentFrame = {
  frame: number;
  /** Glyph pixels found. */
  glyphs: number;
  /** Where the glyphs sit in the plane's rectangle (pixels of the rectangle, robust to a few stray pixels). */
  box: PlaneBox | null;
  /** The rectangle's size in pixels. */
  plane: { width: number; height: number };
  /** Glyph pixels further than the tolerance outside the plane (outside the rectangle for a clipped title, above or below it for one that may overflow sideways). */
  outside: number;
  /** Screen bounding box of the glyphs, for the report. */
  screen: PlaneBox | null;
};

/** The size of a plane's rectangle, as the composition sizes the title's box: the mean of the top and bottom edges by the mean of the sides. */
export function planeRect(base: readonly number[], width: number, height: number): { width: number; height: number } {
  const px = (i: number) => base[i * 2] * width, py = (i: number) => base[i * 2 + 1] * height;
  const edge = (a: number, b: number) => Math.hypot(px(b) - px(a), py(b) - py(a));
  return { width: Math.max(1, (edge(0, 1) + edge(3, 2)) / 2), height: Math.max(1, (edge(0, 3) + edge(1, 2)) / 2) };
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/**
 * One frame: the glyph mask (1 = title pixel, `width`×`height`), the plane's
 * corners now and the plane it was laid out in (frame fractions).
 */
export function measureAttachment(input: { frame: number; mask: Uint8Array; width: number; height: number; quad: readonly number[]; base: readonly number[]; clipped: boolean; tolerancePx: number }): AttachmentFrame {
  const { mask, width, height, quad, base, clipped, tolerancePx: tol } = input;
  const rect = planeRect(base, width, height);
  const now = quad.map((v, i) => v * (i % 2 === 0 ? width : height)) as Quad;
  const H = homography([0, 0, rect.width, 0, rect.width, rect.height, 0, rect.height], now);
  const inv = H ? invertHomography(H) : null;
  const us: number[] = [], vs: number[] = [], xs: number[] = [], ys: number[] = [];
  let outside = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = (i % width) + 0.5, y = Math.floor(i / width) + 0.5;
    xs.push(x); ys.push(y);
    if (!inv) continue;
    const [u, v] = applyHomography(inv, x, y);
    us.push(u); vs.push(v);
    const offSide = clipped && (u < -tol || u > rect.width + tol);
    if (offSide || v < -tol || v > rect.height + tol) outside++;
  }
  const glyphs = xs.length;
  const box = (a: number[], b: number[]): PlaneBox | null => {
    if (!a.length) return null;
    const sa = [...a].sort((p, q) => p - q), sb = [...b].sort((p, q) => p - q);
    return { left: quantile(sa, 0.002), right: quantile(sa, 0.998), top: quantile(sb, 0.002), bottom: quantile(sb, 0.998) };
  };
  return { frame: input.frame, glyphs, box: box(us, vs), plane: rect, outside: inv ? outside : glyphs, screen: box(xs, ys) };
}

export type AttachmentVerdict = { ok: boolean; problems: string[]; drift: number };

/**
 * The verdict over a title's frames: every frame with glyphs keeps them on the
 * plane (no more than `allowOutside` of them past the tolerance), an
 * overflowing title stays centred on its plane, and the glyphs' place in the
 * plane's rectangle drifts no more than the tolerance from frame to frame.
 * Frames where the title is faded out (`expectVisible` false) may be empty.
 */
export function judgeAttachment(frames: (AttachmentFrame & { expectVisible: boolean; fullStrength: boolean; clipped: boolean })[], tolerancePx: number, allowOutside = 0.005): AttachmentVerdict {
  const problems: string[] = [];
  // A fading title loses its faint edge pixels to the difference threshold: drift is judged only on frames drawn near full strength.
  const seen = frames.filter((f) => f.box && f.fullStrength);
  for (const f of frames) {
    if (!f.box) {
      if (f.expectVisible) problems.push(`frame ${f.frame}: the title should be visible but drew no pixels`);
      continue;
    }
    if (f.outside > Math.max(3, allowOutside * f.glyphs)) problems.push(`frame ${f.frame}: ${f.outside} of ${f.glyphs} glyph pixels lie off the plane (tolerance ${tolerancePx} px)`);
    if (!f.clipped) {
      const centre = (f.box.left + f.box.right) / 2;
      if (Math.abs(centre - f.plane.width / 2) > tolerancePx) problems.push(`frame ${f.frame}: the title is centred ${(centre - f.plane.width / 2).toFixed(1)} px off its plane's centre`);
    }
  }
  let drift = 0;
  if (seen.length > 1) {
    const edges: (keyof PlaneBox)[] = ["left", "right", "top", "bottom"];
    for (const edge of edges) {
      const values = seen.map((f) => f.box![edge]).sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)];
      for (const f of seen) drift = Math.max(drift, Math.abs(f.box![edge] - median));
    }
    if (drift > tolerancePx) problems.push(`the title moves ${drift.toFixed(1)} px within its plane between frames (tolerance ${tolerancePx} px)`);
  }
  return { ok: problems.length === 0, problems, drift };
}
