/**
 * Cleaning up a person matte (ADR 0039, fourth attempt; buffers ADR 0051).
 * The segmenter's mask comes from a 256×256 model, so at 1080×1920 its edge
 * is a soft stair that cuts through hair and sleeves and flickers between
 * frames. These are plain array operations on a mask and the picture's
 * luminance, so they are tested without a DOM:
 *
 * - `boundingBox`: where the person is, so the segmenter can be run again on
 *   a crop and see the person at four times the detail.
 * - `guidedFilter`: pulls the soft mask's edge onto the picture's own edges
 *   (He, Sun & Tang's guided filter, with box sums from integral images).
 * - `grow`: dilates by one pixel so a letter never bleeds into the body.
 * - `blend`: eases the mask toward the previous frame's to stop flicker.
 *
 * Every operation takes an optional `Workspace` (and where it makes sense an
 * `out` buffer). With one, the working arrays are allocated once and reused
 * frame after frame; without one each call allocates, as before, so one-off
 * callers and the tests stay simple. The arithmetic is the same either way.
 */

export type Mask = { data: Float32Array; width: number; height: number };

type Pooled = Float32Array | Float64Array | Uint8ClampedArray;

/**
 * Reusable scratch arrays, by name. A request returns a view of exactly the
 * length asked for over a buffer that only grows (to `capacity` at least), so
 * a crop that changes size every frame does not reallocate. `allocations`
 * counts the buffers ever made: after the first frames it must stop moving.
 */
export class Workspace {
  allocations = 0;
  private readonly pool = new Map<string, Pooled>();

  private take<T extends Pooled>(name: string, length: number, capacity: number, make: (n: number) => T): T {
    let buffer = this.pool.get(name) as T | undefined;
    if (!buffer || buffer.length < length) {
      buffer = make(Math.max(length, capacity));
      this.pool.set(name, buffer);
      this.allocations++;
    }
    return (buffer.length === length ? buffer : buffer.subarray(0, length)) as T;
  }

  f32(name: string, length: number, capacity = 0): Float32Array {
    return this.take(name, length, capacity, (n) => new Float32Array(n));
  }

  f64(name: string, length: number, capacity = 0): Float64Array {
    return this.take(name, length, capacity, (n) => new Float64Array(n));
  }

  u8(name: string, length: number, capacity = 0): Uint8ClampedArray {
    return this.take(name, length, capacity, (n) => new Uint8ClampedArray(n));
  }
}

/** The tight box (inclusive–exclusive) of mask values above `threshold`, or null when there is no person. */
export function boundingBox(mask: Mask, threshold = 0.5): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = mask.width, y0 = mask.height, x1 = -1, y1 = -1;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (mask.data[y * mask.width + x] > threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Box-filtered mean of `src` over a (2r+1)² window, edges clamped, via an integral image, into `out`. */
function boxMean(src: Float32Array, width: number, height: number, r: number, out: Float32Array, integral: Float64Array): Float32Array {
  const stride = width + 1;
  integral.fill(0, 0, stride);
  for (let y = 1; y <= height; y++) {
    let row = 0;
    integral[y * stride] = 0;
    for (let x = 1; x <= width; x++) {
      row += src[(y - 1) * width + (x - 1)];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + row;
    }
  }
  for (let y = 0; y < height; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(width, x + r + 1);
      const sum = integral[yb * stride + xb] - integral[ya * stride + xb] - integral[yb * stride + xa] + integral[ya * stride + xa];
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
 * `out` must not be `mask.data` or `guide`.
 */
export function guidedFilter(mask: Mask, guide: Float32Array, radius = 6, eps = 2e-3, ws: Workspace = new Workspace(), out?: Float32Array): Mask {
  const { width, height } = mask;
  const n = width * height;
  const integral = ws.f64("gf.integral", (width + 1) * (height + 1));
  const meanI = boxMean(guide, width, height, radius, ws.f32("gf.meanI", n), integral);
  const meanP = boxMean(mask.data, width, height, radius, ws.f32("gf.meanP", n), integral);
  // ii and ip are dead once their means are taken, so a and b reuse them.
  const ii = ws.f32("gf.t1", n), ip = ws.f32("gf.t2", n);
  for (let i = 0; i < n; i++) { ii[i] = guide[i] * guide[i]; ip[i] = guide[i] * mask.data[i]; }
  const meanII = boxMean(ii, width, height, radius, ws.f32("gf.meanII", n), integral);
  const meanIP = boxMean(ip, width, height, radius, ws.f32("gf.meanIP", n), integral);
  const a = ii, b = ip;
  for (let i = 0; i < n; i++) {
    const varI = meanII[i] - meanI[i] * meanI[i];
    const covIP = meanIP[i] - meanI[i] * meanP[i];
    a[i] = covIP / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxMean(a, width, height, radius, meanII, integral), meanB = boxMean(b, width, height, radius, meanIP, integral);
  const result = out ?? new Float32Array(n);
  for (let i = 0; i < n; i++) result[i] = Math.max(0, Math.min(1, meanA[i] * guide[i] + meanB[i]));
  return { data: result, width, height };
}

/** Grows the mask by `px` pixels (a max filter), so the matte covers the body's edge rather than stopping short of it. */
export function grow(mask: Mask, px = 1, ws?: Workspace, out?: Float32Array): Mask {
  const { width, height } = mask;
  const n = width * height;
  if (px <= 0) {
    if (!out) return mask;
    out.set(mask.data);
    return { data: out, width, height };
  }
  let cur = mask.data;
  for (let pass = 0; pass < px; pass++) {
    const last = pass === px - 1;
    // Ping-pong between two pooled buffers; the last pass writes straight into `out`.
    const next = last && out ? out : ws ? ws.f32(pass % 2 ? "grow.b" : "grow.a", n) : new Float32Array(n);
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
export function blend(mask: Mask, previous: Mask | null, keep = 0.35, out?: Float32Array): Mask {
  if (!previous || previous.width !== mask.width || previous.height !== mask.height) {
    if (!out) return mask;
    out.set(mask.data);
    return { data: out, width: mask.width, height: mask.height };
  }
  const result = out ?? new Float32Array(mask.data.length);
  for (let i = 0; i < result.length; i++) result[i] = mask.data[i] * (1 - keep) + previous.data[i] * keep;
  return { data: result, width: mask.width, height: mask.height };
}

/** A soft mask to an alpha 0–255: confident person pixels opaque, the uncertain band feathered between `low` and `high`. */
export function toAlpha(mask: Mask, low = 0.3, high = 0.6, out?: Uint8ClampedArray): Uint8ClampedArray {
  const result = out ?? new Uint8ClampedArray(mask.data.length);
  for (let i = 0; i < mask.data.length; i++) result[i] = Math.round(Math.max(0, Math.min(1, (mask.data[i] - low) / (high - low))) * 255);
  return result;
}

/** Bilinear resample of a mask to another size. */
export function resample(mask: Mask, width: number, height: number, out?: Float32Array): Mask {
  const result = out ?? new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = ((y + 0.5) * mask.height) / height - 0.5, y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(mask.height - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < width; x++) {
      const sx = ((x + 0.5) * mask.width) / width - 0.5, x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(mask.width - 1, x0 + 1), fx = Math.max(0, sx - x0);
      const top = mask.data[y0 * mask.width + x0] * (1 - fx) + mask.data[y0 * mask.width + x1] * fx;
      const bottom = mask.data[y1 * mask.width + x0] * (1 - fx) + mask.data[y1 * mask.width + x1] * fx;
      result[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return { data: result, width, height };
}

/** Pastes `crop` (a mask of a sub-rectangle) into a full-size zero mask at (x0, y0). */
export function paste(crop: Mask, width: number, height: number, x0: number, y0: number, out?: Float32Array): Mask {
  const result = out ? out.fill(0) : new Float32Array(width * height);
  for (let y = 0; y < crop.height; y++) { const yy = y + y0; if (yy < 0 || yy >= height) continue; for (let x = 0; x < crop.width; x++) { const xx = x + x0; if (xx < 0 || xx >= width) continue; result[yy * width + xx] = crop.data[y * crop.width + x]; } }
  return { data: result, width, height };
}

/** Rec. 601 luminance 0–1 of RGBA pixels: the guide the guided filter snaps to, and what the point tracker matches. */
export function luminance(rgba: Uint8ClampedArray, out: Float32Array): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  return out;
}
