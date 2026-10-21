/**
 * Pixels for the acceptance harness (ADR 0053): an RGB image, and the two
 * measures it compares frames with. Written here rather than pulled in, so
 * the harness adds no dependency: ffmpeg decodes and encodes, this compares.
 */

/** Packed 8-bit RGB, row by row. */
export type Rgb = { width: number; height: number; data: Uint8Array };

export function blank(width: number, height: number, value = 0): Rgb {
  return { width, height, data: new Uint8Array(width * height * 3).fill(value) };
}

/** Rec. 601 luma of every pixel, 0–255. */
export function luma(image: Rgb): Float32Array {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 3) out[i] = 0.299 * image.data[p] + 0.587 * image.data[p + 1] + 0.114 * image.data[p + 2];
  return out;
}

/** A rectangle of an image, clamped to its edges. */
export function crop(image: Rgb, x: number, y: number, width: number, height: number): Rgb {
  const x0 = Math.max(0, Math.min(image.width, Math.round(x))), y0 = Math.max(0, Math.min(image.height, Math.round(y)));
  const w = Math.max(0, Math.min(image.width - x0, Math.round(width))), h = Math.max(0, Math.min(image.height - y0, Math.round(height)));
  const out = blank(w, h);
  for (let row = 0; row < h; row++) out.data.set(image.data.subarray(((y0 + row) * image.width + x0) * 3, ((y0 + row) * image.width + x0 + w) * 3), row * w * 3);
  return out;
}

/** Resampled to a size by averaging the source pixels under each output pixel (area filter): shrinking is fair, growing is nearest. */
export function resize(image: Rgb, width: number, height: number): Rgb {
  if (image.width === width && image.height === height) return image;
  const out = blank(width, height);
  const sx = image.width / width, sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const p = (yy * image.width + xx) * 3;
        r += image.data[p]; g += image.data[p + 1]; b += image.data[p + 2]; n++;
      }
      const q = (y * width + x) * 3;
      out.data[q] = r / n; out.data[q + 1] = g / n; out.data[q + 2] = b / n;
    }
  }
  return out;
}

/**
 * Mean structural similarity of the two images' luma over 8×8 windows
 * (stride 4), with the usual constants for 8-bit data. 1 is identical;
 * a re-encode of the same picture scores about 0.97–0.99, a moved title
 * or a different frame far less. The images must be the same size.
 */
export function ssim(a: Rgb, b: Rgb, window = 8, stride = 4): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`ssim: sizes differ (${a.width}×${a.height} vs ${b.width}×${b.height})`);
  const la = luma(a), lb = luma(b);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const n = window * window;
  let total = 0, count = 0;
  for (let y = 0; y + window <= a.height; y += stride) {
    for (let x = 0; x + window <= a.width; x += stride) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let yy = 0; yy < window; yy++) {
        const row = (y + yy) * a.width + x;
        for (let xx = 0; xx < window; xx++) {
          const va = la[row + xx], vb = lb[row + xx];
          sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
        }
      }
      const ma = sa / n, mb = sb / n;
      const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return count ? total / count : 1;
}

/**
 * The worst block: both images cut into blocks of `block` pixels, each
 * block's mean colour compared, and the largest difference returned (0–255).
 * SSIM averages a local change away; this one does not, so a title that
 * appears in one picture and not the other shows here even when it is small.
 */
export function worstBlockDiff(a: Rgb, b: Rgb, block = 16): { diff: number; x: number; y: number } {
  if (a.width !== b.width || a.height !== b.height) throw new Error("worstBlockDiff: sizes differ");
  let worst = { diff: 0, x: 0, y: 0 };
  for (let y = 0; y < a.height; y += block) {
    for (let x = 0; x < a.width; x += block) {
      const sums = [0, 0, 0, 0, 0, 0];
      let n = 0;
      for (let yy = y; yy < Math.min(a.height, y + block); yy++) {
        for (let xx = x; xx < Math.min(a.width, x + block); xx++) {
          const p = (yy * a.width + xx) * 3;
          for (let c = 0; c < 3; c++) { sums[c] += a.data[p + c]; sums[c + 3] += b.data[p + c]; }
          n++;
        }
      }
      const diff = Math.max(...[0, 1, 2].map((c) => Math.abs(sums[c] - sums[c + 3]) / n));
      if (diff > worst.diff) worst = { diff, x, y };
    }
  }
  return worst;
}

export type FrameScore = { ssim: number; worstBlock: number; worstAt: { x: number; y: number } };

/** Both measures at a common comparison size (the first image's size if none is given). */
export function compareImages(a: Rgb, b: Rgb, size?: { width: number; height: number }): FrameScore {
  const w = size?.width ?? a.width, h = size?.height ?? a.height;
  const ra = resize(a, w, h), rb = resize(b, w, h);
  const worst = worstBlockDiff(ra, rb);
  return { ssim: ssim(ra, rb), worstBlock: worst.diff, worstAt: { x: worst.x, y: worst.y } };
}

export type Tolerance = { minSsim: number; maxBlock: number };

export function withinTolerance(score: FrameScore, tolerance: Tolerance): boolean {
  return score.ssim >= tolerance.minSsim && score.worstBlock <= tolerance.maxBlock;
}

/**
 * Pixels that differ between two pictures of the same size by more than
 * `threshold` in any channel: what a title adds to a frame, when one
 * picture has it and the other is the same frame without it.
 */
export function differenceMask(a: Rgb, b: Rgb, threshold = 24): Uint8Array {
  if (a.width !== b.width || a.height !== b.height) throw new Error("differenceMask: sizes differ");
  const mask = new Uint8Array(a.width * a.height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    if (Math.abs(a.data[p] - b.data[p]) > threshold || Math.abs(a.data[p + 1] - b.data[p + 1]) > threshold || Math.abs(a.data[p + 2] - b.data[p + 2]) > threshold) mask[i] = 1;
  }
  return mask;
}

/**
 * Over a title's own pixels (a mask, usually its glyphs grown by a pixel),
 * the fraction whose luma differs between the two pictures by more than
 * `threshold`. Whole-frame scores average a missing title away (its letters
 * are a few percent of the frame and of any 16-px block they cross); counted
 * pixel by pixel over the letters themselves, a missing title is most of
 * them and an encoder's loss a few.
 */
export function regionChange(a: Rgb, b: Rgb, mask: Uint8Array, threshold = 32): number {
  if (a.width !== b.width || a.height !== b.height || mask.length !== a.width * a.height) throw new Error("regionChange: sizes differ");
  let changed = 0, n = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    if (!mask[i]) continue;
    const la = 0.299 * a.data[p] + 0.587 * a.data[p + 1] + 0.114 * a.data[p + 2];
    const lb = 0.299 * b.data[p] + 0.587 * b.data[p + 1] + 0.114 * b.data[p + 2];
    if (Math.abs(la - lb) > threshold) changed++;
    n++;
  }
  return n ? changed / n : 0;
}

/** A mask grown by `radius` pixels (square neighbourhood). */
export function growMask(mask: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && xx >= 0 && yy < height && xx < width) out[yy * width + xx] = 1;
    }
  }
  return out;
}

/** The bounding box of the set pixels of a mask, or null when none is set. */
export function maskBounds(mask: Uint8Array, width: number): { left: number; top: number; right: number; bottom: number; count: number } | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width, y = Math.floor(i / width);
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
    count++;
  }
  return count ? { left, top, right, bottom, count } : null;
}

/**
 * A contact sheet: rows of tiles, each tile scaled to `tile` wide (keeping
 * the 9:16 of the frames), a dark gutter between them. One row per shot,
 * like the owner's five-frame strips.
 */
export function contactSheet(rows: Rgb[][], tile = 180, gutter = 6): Rgb {
  const first = rows.flat()[0];
  const tileHeight = first ? Math.round((tile * first.height) / first.width) : Math.round((tile * 16) / 9);
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const width = gutter + columns * (tile + gutter), height = gutter + rows.length * (tileHeight + gutter);
  const sheet = blank(width, height, 24);
  rows.forEach((row, r) => row.forEach((image, c) => {
    const small = resize(image, tile, tileHeight);
    const x0 = gutter + c * (tile + gutter), y0 = gutter + r * (tileHeight + gutter);
    for (let y = 0; y < tileHeight; y++) sheet.data.set(small.data.subarray(y * tile * 3, (y + 1) * tile * 3), ((y0 + y) * width + x0) * 3);
  }));
  return sheet;
}
