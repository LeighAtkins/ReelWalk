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
    // The full travel of each edge across the frames (largest less smallest), not the distance from a
    // middle value: steps of 0, 2, 4, 6, 8 px are 8 px of travel and must count as 8.
    for (const edge of edges) {
      const values = seen.map((f) => f.box![edge]);
      drift = Math.max(drift, Math.max(...values) - Math.min(...values));
    }
    if (drift > tolerancePx) problems.push(`the title moves ${drift.toFixed(1)} px within its plane between frames (tolerance ${tolerancePx} px)`);
  }
  return { ok: problems.length === 0, problems, drift };
}

/**
 * The glyph mask carried into the plane's own rectangle (one cell per pixel
 * of the rectangle): every cell is mapped forward through the plane's
 * homography and samples the screen mask. A title fixed to its plane gives
 * the same rectified mask on every frame; a mirrored, thinned or sliding one
 * does not. An unclipped title may overflow sideways, so its rectangle is
 * widened by a plane width either side.
 */
export type Rectified = { cols: number; rows: number; data: Uint8Array };

export function rectifyMask(input: { mask: Uint8Array; width: number; height: number; quad: readonly number[]; base: readonly number[]; clipped: boolean }): Rectified {
  const { mask, width, height, quad, base, clipped } = input;
  const rect = planeRect(base, width, height);
  const now = quad.map((v, i) => v * (i % 2 === 0 ? width : height)) as Quad;
  const H = homography([0, 0, rect.width, 0, rect.width, rect.height, 0, rect.height], now);
  const u0 = clipped ? 0 : -rect.width;
  const cols = Math.round(clipped ? rect.width : rect.width * 3), rows = Math.round(rect.height);
  const data = new Uint8Array(cols * rows);
  if (!H) return { cols, rows, data };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [x, y] = applyHomography(H, u0 + c + 0.5, r + 0.5);
      const px = Math.floor(x), py = Math.floor(y);
      if (px >= 0 && py >= 0 && px < width && py < height && mask[py * width + px]) data[r * cols + c] = 1;
    }
  }
  return { cols, rows, data };
}

/** A mask with every set cell's neighbours within `radius` set too (square neighbourhood). */
function dilate(m: Rectified, radius: number): Uint8Array {
  const out = new Uint8Array(m.data.length);
  for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
    if (!m.data[r * m.cols + c]) continue;
    for (let dr = -radius; dr <= radius; dr++) for (let dc = -radius; dc <= radius; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < m.rows && cc < m.cols) out[rr * m.cols + cc] = 1;
    }
  }
  return out;
}

/**
 * How much of each mask lies within `radius` cells of the other (a symmetric
 * F-score, 0 to 1): 1 for the same letters, low for the letters mirrored,
 * moved or of another weight. The radius forgives anti-aliasing and resampling.
 */
export function overlapScore(a: Rectified, b: Rectified, radius = 2): number {
  if (a.cols !== b.cols || a.rows !== b.rows) return 0;
  const da = dilate(a, radius), db = dilate(b, radius);
  let na = 0, nb = 0, hitA = 0, hitB = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i]) { na++; if (db[i]) hitA++; }
    if (b.data[i]) { nb++; if (da[i]) hitB++; }
  }
  return na + nb ? (hitA + hitB) / (na + nb) : 1;
}

/** Mean stroke width in cells: the set area over half its perimeter (set cells with an unset 4-neighbour). */
export function strokeWidth(m: Rectified): number {
  const at = (r: number, c: number) => r >= 0 && c >= 0 && r < m.rows && c < m.cols && m.data[r * m.cols + c] === 1;
  let area = 0, edge = 0;
  for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
    if (!at(r, c)) continue;
    area++;
    if (!at(r - 1, c) || !at(r + 1, c) || !at(r, c - 1) || !at(r, c + 1)) edge++;
  }
  return edge ? area / (edge / 2) : 0;
}

/** Ink per column (or row) across the mask's own extent, resampled to `bins` and centred on zero. */
function profile(m: Rectified, axis: "cols" | "rows", bins = 48): number[] {
  const along = axis === "cols" ? m.cols : m.rows, across = axis === "cols" ? m.rows : m.cols;
  const sums: number[] = new Array(along).fill(0);
  for (let i = 0; i < along; i++) for (let j = 0; j < across; j++) sums[i] += axis === "cols" ? m.data[j * m.cols + i] : m.data[i * m.cols + j];
  let first = sums.findIndex((v) => v > 0);
  let last = along - 1 - [...sums].reverse().findIndex((v) => v > 0);
  if (first < 0) { first = 0; last = along - 1; }
  const span = last - first + 1;
  const out = Array.from({ length: bins }, (_, b) => {
    const from = first + Math.floor((b * span) / bins), to = Math.max(from + 1, first + Math.floor(((b + 1) * span) / bins));
    let s = 0;
    for (let i = from; i < to; i++) s += sums[i];
    return s / (to - from);
  });
  const mean = out.reduce((a, b) => a + b, 0) / bins;
  return out.map((v) => v - mean);
}

function correlation(a: number[], b: number[]): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * Which way round the letters are, against a reference: the correlation of
 * the ink profiles across and down with the reference's, and with the
 * reference's reversed. Profiles run over each mask's own extent, so a
 * slightly different rasteriser does not matter; the order of the letters does.
 */
export function orientation(m: Rectified, reference: Rectified): { across: number; acrossMirrored: number; down: number; downFlipped: number } {
  const c = profile(m, "cols"), rc = profile(reference, "cols"), r = profile(m, "rows"), rr = profile(reference, "rows");
  return { across: correlation(c, rc), acrossMirrored: correlation(c, [...rc].reverse()), down: correlation(r, rr), downFlipped: correlation(r, [...rr].reverse()) };
}

/** Limits for the shape checks, calibrated on the smoke (ADR 0053). */
export const SHAPE = {
  /** Every frame's letters against the first full-strength frame's, within 2 cells. */
  minFrameOverlap: 0.8,
  /** The reference's profile must beat its own reversal by this much. */
  orientationMargin: 0.15,
  /** Stroke width within this many cells of the reference's, or this fraction of it, whichever is larger. */
  strokeCells: 0.75,
  strokeFraction: 0.04,
  /** Against the approved reference mask (strict baseline mode only: rasterisers differ between machines). */
  minReferenceOverlap: 0.7,
};

export type ShapeVerdict = { ok: boolean; problems: string[]; detail: Record<string, number> };

/**
 * The letters' shape on the plane: the same on every frame (overlap with the
 * first), the right way round and of the right weight against an approved
 * reference rectified mask, and (strict) overlapping it.
 */
export function judgeShape(frames: { frame: number; rectified: Rectified; fullStrength: boolean; glyphs: number }[], reference: Rectified | null, strict: boolean): ShapeVerdict {
  const problems: string[] = [];
  const detail: Record<string, number> = {};
  const seen = frames.filter((f) => f.fullStrength && f.glyphs > 0);
  if (!seen.length) return { ok: false, problems: ["no frame drew the title at full strength, so its shape could not be checked"], detail };
  const first = seen[0];
  let worst = 1;
  for (const f of seen.slice(1)) worst = Math.min(worst, overlapScore(f.rectified, first.rectified));
  detail.frameOverlap = worst;
  if (worst < SHAPE.minFrameOverlap) problems.push(`the letters change shape on the plane between frames (overlap ${worst.toFixed(2)} < ${SHAPE.minFrameOverlap})`);
  if (!reference) {
    problems.push("no approved reference mask to check orientation and weight against");
    return { ok: false, problems, detail };
  }
  const widths = seen.map((f) => strokeWidth(f.rectified));
  const width = widths.reduce((a, b) => a + b, 0) / widths.length, refWidth = strokeWidth(reference);
  detail.strokeWidth = width;
  detail.referenceStrokeWidth = refWidth;
  if (Math.abs(width - refWidth) > Math.max(SHAPE.strokeCells, SHAPE.strokeFraction * refWidth)) problems.push(`the strokes are ${width.toFixed(2)} px wide against the reference's ${refWidth.toFixed(2)} px`);
  let across = 1, down = 1;
  for (const f of seen) {
    const o = orientation(f.rectified, reference);
    across = Math.min(across, o.across - o.acrossMirrored);
    down = Math.min(down, o.down - o.downFlipped);
  }
  detail.acrossMargin = across;
  detail.downMargin = down;
  // An axis is judged only when the reference itself reads differently reversed along it (a title as
  // symmetric top to bottom as "HOH" cannot be told upside down by its profile, and is not failed for it).
  const self = orientation(reference, reference);
  detail.referenceAcross = self.across - self.acrossMirrored;
  detail.referenceDown = self.down - self.downFlipped;
  if (detail.referenceAcross >= 2 * SHAPE.orientationMargin && across < SHAPE.orientationMargin) problems.push(`the letters read mirrored or scrambled across the plane (profile margin ${across.toFixed(2)} < ${SHAPE.orientationMargin})`);
  if (detail.referenceDown >= 2 * SHAPE.orientationMargin && down < SHAPE.orientationMargin) problems.push(`the letters read upside down on the plane (profile margin ${down.toFixed(2)} < ${SHAPE.orientationMargin})`);
  const refOverlap = Math.min(...seen.map((f) => overlapScore(f.rectified, reference)));
  detail.referenceOverlap = refOverlap;
  if (strict && refOverlap < SHAPE.minReferenceOverlap) problems.push(`the letters differ from the approved reference (overlap ${refOverlap.toFixed(2)} < ${SHAPE.minReferenceOverlap})`);
  return { ok: problems.length === 0, problems, detail };
}

/** A screen mask with each set pixel cleared when any 4-neighbour is unset: the letters one pixel thinner all round. */
export function erode(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - width] && mask[i + width]) out[i] = 1;
  }
  return out;
}

/** The plane's corners in mirrored order (top right, top left, bottom left, bottom right): a title placed from a mirrored drag. */
export function mirroredCorners(quad: readonly number[]): number[] {
  return [2, 3, 0, 1, 6, 7, 4, 5].map((i) => quad[i]);
}
