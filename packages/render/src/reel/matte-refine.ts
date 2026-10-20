/**
 * Cleaning up a person matte (ADR 0039, fourth attempt). The segmenter's
 * mask comes from a 256×256 model, so at 1080×1920 its edge is a soft stair
 * that cuts through hair and sleeves and flickers between frames. These are
 * plain array operations on a mask and the picture's luminance, so they are
 * tested without a DOM:
 *
 * - `boundingBox`: where the person is, so the segmenter can be run again on
 *   a crop and see the person at four times the detail.
 * - `guidedFilter`: pulls the soft mask's edge onto the picture's own edges
 *   (He, Sun & Tang's guided filter, with box sums from integral images).
 * - `grow`: dilates by one pixel so a letter never bleeds into the body.
 * - `blend`: eases the mask toward the previous frame's to stop flicker.
 */

export type Mask = { data: Float32Array; width: number; height: number };

/** The tight box (inclusive–exclusive) of mask values above `threshold`, or null when there is no person. */
export function boundingBox(mask: Mask, threshold = 0.5): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = mask.width, y0 = mask.height, x1 = -1, y1 = -1;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (mask.data[y * mask.width + x] > threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Box-filtered mean of `src` over a (2r+1)² window, edges clamped, via an integral image. */
function boxMean(src: Float32Array, width: number, height: number, r: number): Float32Array {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let row = 0;
    for (let x = 1; x <= width; x++) {
      row += src[(y - 1) * width + (x - 1)];
      integral[y * (width + 1) + x] = integral[(y - 1) * (width + 1) + x] + row;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(width, x + r + 1);
      const sum = integral[yb * (width + 1) + xb] - integral[ya * (width + 1) + xb] - integral[yb * (width + 1) + xa] + integral[ya * (width + 1) + xa];
      out[y * width + x] = sum / ((yb - ya) * (xb - xa));
    }
  }
  return out;
}

/**
 * The guided filter: `mask` smoothed where `guide` (luminance 0–1) is flat and
 * kept sharp where the guide has an edge, so the matte's boundary snaps to
 * the real outline of hair, shoulders and sleeves. `radius` in pixels,
 * `eps` the edge strength below which the guide is treated as flat.
 */
export function guidedFilter(mask: Mask, guide: Float32Array, radius = 6, eps = 2e-3): Mask {
  const { width, height } = mask;
  const n = width * height;
  const meanI = boxMean(guide, width, height, radius);
  const meanP = boxMean(mask.data, width, height, radius);
  const ii = new Float32Array(n), ip = new Float32Array(n);
  for (let i = 0; i < n; i++) { ii[i] = guide[i] * guide[i]; ip[i] = guide[i] * mask.data[i]; }
  const meanII = boxMean(ii, width, height, radius), meanIP = boxMean(ip, width, height, radius);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = meanII[i] - meanI[i] * meanI[i];
    const covIP = meanIP[i] - meanI[i] * meanP[i];
    a[i] = covIP / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxMean(a, width, height, radius), meanB = boxMean(b, width, height, radius);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(1, meanA[i] * guide[i] + meanB[i]));
  return { data: out, width, height };
}

/** Grows the mask by `px` pixels (a max filter), so the matte covers the body's edge rather than stopping short of it. */
export function grow(mask: Mask, px = 1): Mask {
  let cur = mask.data;
  const { width, height } = mask;
  for (let pass = 0; pass < px; pass++) {
    const next = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= height) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= width) continue; const v = cur[yy * width + xx]; if (v > m) m = v; } }
      next[y * width + x] = m;
    }
    cur = next;
  }
  return { data: cur, width, height };
}

/** Eases this frame's mask toward the previous one (same size), `keep` being the share of the previous frame. */
export function blend(mask: Mask, previous: Mask | null, keep = 0.35): Mask {
  if (!previous || previous.width !== mask.width || previous.height !== mask.height) return mask;
  const out = new Float32Array(mask.data.length);
  for (let i = 0; i < out.length; i++) out[i] = mask.data[i] * (1 - keep) + previous.data[i] * keep;
  return { data: out, width: mask.width, height: mask.height };
}

/** A soft mask to an alpha 0–255: confident person pixels opaque, the uncertain band feathered between `low` and `high`. */
export function toAlpha(mask: Mask, low = 0.3, high = 0.6): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, (mask.data[i] - low) / (high - low))) * 255);
  return out;
}

/** Bilinear resample of a mask to another size. */
export function resample(mask: Mask, width: number, height: number): Mask {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = ((y + 0.5) * mask.height) / height - 0.5, y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(mask.height - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < width; x++) {
      const sx = ((x + 0.5) * mask.width) / width - 0.5, x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(mask.width - 1, x0 + 1), fx = Math.max(0, sx - x0);
      const top = mask.data[y0 * mask.width + x0] * (1 - fx) + mask.data[y0 * mask.width + x1] * fx;
      const bottom = mask.data[y1 * mask.width + x0] * (1 - fx) + mask.data[y1 * mask.width + x1] * fx;
      out[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return { data: out, width, height };
}

/** Pastes `crop` (a mask of a sub-rectangle) into a full-size zero mask at (x0, y0). */
export function paste(crop: Mask, width: number, height: number, x0: number, y0: number): Mask {
  const out = new Float32Array(width * height);
  for (let y = 0; y < crop.height; y++) { const yy = y + y0; if (yy < 0 || yy >= height) continue; for (let x = 0; x < crop.width; x++) { const xx = x + x0; if (xx < 0 || xx >= width) continue; out[yy * width + xx] = crop.data[y * crop.width + x]; } }
  return { data: out, width, height };
}
