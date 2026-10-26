/**
 * Pixel measures for the shot analysis (ADR 0086): pure arithmetic on small
 * grey or RGB frames, so the worker (ffmpeg frames) and tests (synthetic
 * frames) share them. Nothing here allocates more than a few frames' worth.
 */
import type { Gray } from "./motion";

/** An 8-bit RGB frame, row-major, 3 bytes a pixel. */
export type Rgb = { data: Uint8Array; width: number; height: number };

/** Grey (BT.601 luma, 0..255) of an RGB frame. */
export function rgbToGray(rgb: Rgb): Gray {
  const { width, height, data } = rgb;
  const out = new Float32Array(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 3) out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return { data: out, width, height };
}

/** A grey frame shrunk to `width` × `height` by area averaging (each output pixel is the mean of its source box). */
export function resizeGray(gray: Gray, width: number, height: number): Gray {
  const out = new Float32Array(width * height);
  const sx = gray.width / width, sy = gray.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += gray.data[yy * gray.width + xx];
      out[y * width + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { data: out, width, height };
}

/** Variance of the 4-neighbour Laplacian: the standard focus measure (higher is sharper), on 0..255 grey. */
export function laplacianVariance(gray: Gray, region?: { x0: number; y0: number; x1: number; y1: number }): number {
  const { width, height, data } = gray;
  const x0 = Math.max(1, region?.x0 ?? 1), y0 = Math.max(1, region?.y0 ?? 1);
  const x1 = Math.min(width - 1, region?.x1 ?? width - 1), y1 = Math.min(height - 1, region?.y1 ?? height - 1);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const lap = data[i - 1] + data[i + 1] + data[i - width] + data[i + width] - 4 * data[i];
      sum += lap; sum2 += lap * lap; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

/** Squashes a Laplacian variance to 0..1: half way at `half` (measured on 384 px wide frames of phone footage). */
export function sharpnessScore(variance: number, half = 120): number {
  return variance / (variance + half);
}

/** Crushed and blown shares and the mean luma (0..1) of a grey frame. */
export function exposureStats(gray: Gray): { clipLow: number; clipHigh: number; luma: number } {
  let low = 0, high = 0, sum = 0;
  for (const v of gray.data) {
    if (v < 4) low++;
    else if (v > 251) high++;
    sum += v;
  }
  const n = gray.data.length || 1;
  return { clipLow: low / n, clipHigh: high / n, luma: sum / n / 255 };
}

// ---------------------------------------------------------------------------
// Spectral-residual saliency (Hou & Zhang, CVPR 2007)
// ---------------------------------------------------------------------------

/** In-place radix-2 FFT of `re`/`im` (length a power of two); `inverse` for the inverse transform (unscaled). */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle), wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = next;
      }
    }
  }
}

/** 2-D FFT of an N×N complex image, rows then columns. */
function fft2(re: Float64Array, im: Float64Array, n: number, inverse: boolean): void {
  const rowRe = new Float64Array(n), rowIm = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) { rowRe[x] = re[y * n + x]; rowIm[x] = im[y * n + x]; }
    fft(rowRe, rowIm, inverse);
    for (let x = 0; x < n; x++) { re[y * n + x] = rowRe[x]; im[y * n + x] = rowIm[x]; }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { rowRe[y] = re[y * n + x]; rowIm[y] = im[y * n + x]; }
    fft(rowRe, rowIm, inverse);
    for (let y = 0; y < n; y++) { re[y * n + x] = rowRe[y]; im[y * n + x] = rowIm[y]; }
  }
}

/** Separable box blur, `passes` times (three passes approximate a Gaussian), wrapping nothing: edges clamp. */
function boxBlur(values: Float64Array, width: number, height: number, radius: number, passes = 3): Float64Array {
  let src: Float64Array = values, dst: Float64Array = new Float64Array(values.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, n = 0;
        for (let k = -radius; k <= radius; k++) { const xx = Math.min(width - 1, Math.max(0, x + k)); sum += src[y * width + xx]; n++; }
        dst[y * width + x] = sum / n;
      }
    }
    [src, dst] = [dst, src];
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        let sum = 0, n = 0;
        for (let k = -radius; k <= radius; k++) { const yy = Math.min(height - 1, Math.max(0, y + k)); sum += src[yy * width + x]; n++; }
        dst[y * width + x] = sum / n;
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/** The saliency map side: the method's own 64 px (its authors found the scale stable from 32 to 128). */
export const SALIENCY_SIZE = 64;

/**
 * Spectral-residual saliency of a grey frame: the log amplitude spectrum minus its local mean is what is unexpected in
 * the picture; back in space, squared and blurred, it peaks where the eye goes. Returns the map (SALIENCY_SIZE²,
 * 0..1), its peak in frame fractions (the centroid of the top of the map, steadier than the single brightest pixel),
 * and the peak's strength (how far the peak stands above the map's mean, squashed to 0..1).
 */
export function spectralSaliency(gray: Gray): { x: number; y: number; strength: number; map: Float32Array } {
  const n = SALIENCY_SIZE;
  const small = resizeGray(gray, n, n);
  const re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) re[i] = small.data[i];
  fft2(re, im, n, false);
  const logAmp = new Float64Array(n * n), phaseRe = new Float64Array(n * n), phaseIm = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const amp = Math.hypot(re[i], im[i]);
    logAmp[i] = Math.log(amp + 1e-9);
    phaseRe[i] = amp > 0 ? re[i] / amp : 1;
    phaseIm[i] = amp > 0 ? im[i] / amp : 0;
  }
  // Average filter h_3 of the paper, in the frequency domain: one 3×3 box (radius 1, single pass).
  const smooth = boxBlur(logAmp, n, n, 1, 1);
  for (let i = 0; i < n * n; i++) {
    const residual = Math.exp(logAmp[i] - smooth[i]);
    re[i] = residual * phaseRe[i];
    im[i] = residual * phaseIm[i];
  }
  fft2(re, im, n, true);
  const power = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) power[i] = re[i] * re[i] + im[i] * im[i];
  // Gaussian-ish blur (sigma ≈ 2.5 px at 64 px), as the paper does.
  const blurred = boxBlur(power, n, n, 2, 3);
  // Edges of the FFT image wrap and light up the borders: fade a 3 px margin.
  let max = 0, sum = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const edge = Math.min(x, y, n - 1 - x, n - 1 - y);
      const fade = edge >= 3 ? 1 : edge / 3;
      const v = blurred[y * n + x] * fade;
      blurred[y * n + x] = v;
      max = Math.max(max, v);
      sum += v;
    }
  }
  const map = new Float32Array(n * n);
  if (max <= 0) return { x: 0.5, y: 0.5, strength: 0, map };
  for (let i = 0; i < n * n; i++) map[i] = blurred[i] / max;
  // Centroid of the top 2 % of the map.
  const sorted = Float32Array.from(map).sort();
  const cut = sorted[Math.floor(sorted.length * 0.98)];
  let cx = 0, cy = 0, w = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = map[y * n + x];
    if (v >= cut) { cx += (x + 0.5) * v; cy += (y + 0.5) * v; w += v; }
  }
  const mean = sum / (n * n) / max;
  const ratio = 1 / Math.max(1e-6, mean); // peak over mean
  return { x: cx / w / n, y: cy / w / n, strength: Math.min(1, Math.max(0, (ratio - 2) / 10)), map };
}

// ---------------------------------------------------------------------------
// Vertical strips: what each part of the frame is doing (occluders, parallax)
// ---------------------------------------------------------------------------

export type Strip = {
  /** Mean luma 0..1. */
  luma: number;
  /** Horizontal content shift from the previous frame, px of the analysed frame (> 0 moves right). */
  shift: number;
  /** Mean squared horizontal gradient: detail to follow (a blurred near object has little). */
  texture: number;
};

/**
 * Splits the frame into `count` vertical strips and finds, for each, its own horizontal shift from `prev` (block
 * matching of its column profile within ±`range` px), its mean luma and texture. A near object passing the lens shifts
 * faster than the background (parallax) and is usually dark or soft.
 */
export function stripMotion(prev: Gray, next: Gray, count = 12, range = 10): Strip[] {
  const { width, height } = next;
  const strips: Strip[] = [];
  const stripW = Math.floor(width / count);
  // Row-band profiles: each strip compares several horizontal rows so a single edge is not a coincidence.
  const bands = 6, bandH = Math.floor(height / bands);
  for (let s = 0; s < count; s++) {
    const x0 = s * stripW, x1 = x0 + stripW;
    let luma = 0, texture = 0, n = 0;
    for (let y = 0; y < height; y++) for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      luma += next.data[i];
      if (x > 0) { const g = next.data[i] - next.data[i - 1]; texture += g * g; }
      n++;
    }
    let best = 0, bestCost = Infinity;
    for (let d = -range; d <= range; d++) {
      let cost = 0, m = 0;
      for (let b = 0; b < bands; b++) {
        for (let y = b * bandH; y < (b + 1) * bandH; y += 2) {
          for (let x = x0; x < x1; x++) {
            const px = x - d;
            if (px < 0 || px >= width) continue;
            cost += Math.abs(next.data[y * width + x] - prev.data[y * width + px]);
            m++;
          }
        }
      }
      // A tiny bias toward no shift, so a flat strip reads as still rather than random.
      const mean = m ? cost / m + Math.abs(d) * 0.02 : Infinity;
      if (mean < bestCost) { bestCost = mean; best = d; }
    }
    strips.push({ luma: luma / n / 255, shift: best, texture: texture / n });
  }
  return strips;
}

// ---------------------------------------------------------------------------
// Flow residual: how much change the global flow does not explain
// ---------------------------------------------------------------------------

/**
 * Localised change the global flow does not explain: `prev` is moved by the affine flow (rates per second over
 * `seconds`, content velocity in frame widths, as motion-kind.ts reads it) and compared with `next` cell by cell
 * (`cols` × `rows`). A person or a door moving on its own leaves a few cells far worse than the rest; parallax from an
 * orbit or a walk spreads over the whole picture and so does sensor noise. Returns how far the worst quarter of the
 * cells stands above the median cell, in grey levels over `scale`, 0..1.
 */
export function flowResidual(prev: Gray, next: Gray, flow: { tx: number; ty: number; zoom: number; rotate: number }, seconds: number, { cols = 6, rows = 4, scale = 12 }: { cols?: number; rows?: number; scale?: number } = {}): number {
  const { width, height } = next;
  const fw = width; // flow is in frame widths
  const sums = new Float64Array(cols * rows), counts = new Float64Array(cols * rows);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      // p in frame widths from the centre; content at p in next came from p − flow(p)·t in prev.
      const px = (x - width / 2) / fw, py = (y - height / 2) / fw;
      const vx = flow.tx + flow.zoom * px - flow.rotate * py, vy = flow.ty + flow.zoom * py + flow.rotate * px;
      const sx = x - vx * seconds * fw, sy = y - vy * seconds * fw;
      if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) continue;
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const i = iy * width + ix;
      const v = prev.data[i] * (1 - fx) * (1 - fy) + prev.data[i + 1] * fx * (1 - fy) + prev.data[i + width] * (1 - fx) * fy + prev.data[i + width + 1] * fx * fy;
      const cell = Math.min(rows - 1, Math.floor((y * rows) / height)) * cols + Math.min(cols - 1, Math.floor((x * cols) / width));
      sums[cell] += Math.abs(next.data[y * width + x] - v);
      counts[cell]++;
    }
  }
  const cells = Array.from(sums, (sum, i) => (counts[i] ? sum / counts[i] : 0)).filter((_, i) => counts[i] > 0).sort((a, b) => a - b);
  if (cells.length < 4) return 0;
  const median = cells[Math.floor(cells.length / 2)];
  const top = cells.slice(Math.floor(cells.length * 0.75));
  const worst = top.reduce((a, b) => a + b, 0) / top.length;
  return Math.min(1, Math.max(0, (worst - median * 1.5) / scale));
}

// ---------------------------------------------------------------------------
// Shapes: rectilinear edges and round things
// ---------------------------------------------------------------------------

/** Share of the gradient energy within ±10° of horizontal or vertical edges. */
export function rectilinearity(gray: Gray): number {
  const { width, height, data } = gray;
  let aligned = 0, total = 0;
  const tan10 = Math.tan((10 * Math.PI) / 180);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const gx = data[i + 1] - data[i - 1], gy = data[i + width] - data[i - width];
    const m = gx * gx + gy * gy;
    if (m < 400) continue; // weak edges are noise
    total += m;
    const ax = Math.abs(gx), ay = Math.abs(gy);
    if (ay <= ax * tan10 || ax <= ay * tan10) aligned += m;
  }
  return total ? aligned / total : 0;
}

/**
 * The most convincing circle (a pendant, a mirror, a bowl, a porthole window): gradient-direction Hough voting over
 * radii from 4 % to 25 % of the frame height, then each candidate checked on the picture. Score is the share of the
 * circumference with an edge across the radius there, 0..1.
 */
export function strongestCircle(gray: Gray): { x: number; y: number; r: number; score: number } | null {
  const { width, height, data } = gray;
  const rMin = Math.max(3, Math.round(height * 0.04)), rMax = Math.round(height * 0.25);
  const radii = rMax - rMin + 1;
  const votes = new Float32Array(width * height * radii);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const gx = data[i + 1] - data[i - 1], gy = data[i + width] - data[i - width];
    const m = Math.hypot(gx, gy);
    if (m < 24) continue;
    const ux = gx / m, uy = gy / m;
    for (let r = rMin; r <= rMax; r++) {
      // The centre lies along the gradient, either side (dark-on-light or light-on-dark).
      for (const sign of [1, -1]) {
        const cx = Math.round(x + sign * ux * r), cy = Math.round(y + sign * uy * r);
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
        votes[(r - rMin) * width * height + cy * width + cx] += 1;
      }
    }
  }
  // The strongest vote peaks are only candidates: a thin edge also piles votes up just beside itself at small radii.
  const peaks: { x: number; y: number; r: number; votes: number }[] = [];
  for (let r = rMin; r <= rMax; r++) {
    const base = (r - rMin) * width * height;
    for (let y = r; y < height - r; y++) for (let x = r; x < width - r; x++) {
      // A 3×3 neighbourhood sum forgives rounding.
      let v = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v += votes[base + (y + dy) * width + x + dx];
      const normalised = v / (2 * Math.PI * r);
      if (normalised < 0.3) continue;
      peaks.push({ x, y, r, votes: normalised });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  // Verified on the picture: of 48 points round the circle, how many sit on a strong edge whose gradient points along
  // the radius, less how many do round the same circle moved off its centre (busy texture passes the first test anywhere).
  const onCircle = (cx: number, cy: number, r: number): number => {
    let hits = 0;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
      for (const dr of [-1, 0, 1]) {
        const px = Math.round(cx + ca * (r + dr)), py = Math.round(cy + sa * (r + dr));
        if (px < 1 || py < 1 || px >= width - 1 || py >= height - 1) continue;
        const i = py * width + px;
        const gx = data[i + 1] - data[i - 1], gy = data[i + width] - data[i - width];
        const m = Math.hypot(gx, gy);
        if (m >= 32 && Math.abs((gx * ca + gy * sa) / m) >= 0.92) { hits++; break; }
      }
    }
    return hits / 48;
  };
  let best: { x: number; y: number; r: number; score: number } | null = null;
  for (const peak of peaks.slice(0, 60)) {
    const shift = Math.max(2, peak.r * 0.5);
    const control = Math.max(onCircle(peak.x + shift, peak.y, peak.r), onCircle(peak.x - shift, peak.y, peak.r), onCircle(peak.x, peak.y + shift, peak.r), onCircle(peak.x, peak.y - shift, peak.r));
    const score = Math.max(0, onCircle(peak.x, peak.y, peak.r) - control);
    if (!best || score > best.score || (score === best.score && peak.r > best.r * height)) best = { x: (peak.x + 0.5) / width, y: (peak.y + 0.5) / height, r: peak.r / height, score };
  }
  return best && best.score > 0.35 ? best : null;
}

// ---------------------------------------------------------------------------
// Blown-out regions and colour
// ---------------------------------------------------------------------------

/** The box of blown cells (a grid of `cols` × `rows`, a cell blown when half its pixels are over 250), with its share of the frame. */
export function blownRegion(gray: Gray, cols = 12, rows = 8): { x: number; y: number; w: number; h: number; share: number } | null {
  const { width, height, data } = gray;
  let minX = cols, minY = rows, maxX = -1, maxY = -1, blownPx = 0;
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const x0 = Math.floor((cx * width) / cols), x1 = Math.floor(((cx + 1) * width) / cols);
    const y0 = Math.floor((cy * height) / rows), y1 = Math.floor(((cy + 1) * height) / rows);
    let over = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (data[y * width + x] > 250) over++; n++; }
    blownPx += over;
    if (n && over / n >= 0.5) { minX = Math.min(minX, cx); minY = Math.min(minY, cy); maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy); }
  }
  if (maxX < 0) return null;
  return { x: minX / cols, y: minY / rows, w: (maxX - minX + 1) / cols, h: (maxY - minY + 1) / rows, share: blownPx / (width * height) };
}

/** Dominant colours by k-means (k-means++ seeding, a fixed seed) over sampled pixels [r, g, b, ...], most common first. */
export function dominantColours(pixels: Uint8Array | number[], k = 5, iterations = 12): { hex: string; share: number }[] {
  const n = Math.floor(pixels.length / 3);
  if (!n) return [];
  let seed = 12345;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const at = (i: number) => [pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]];
  const dist = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const centres: number[][] = [at(Math.floor(rand() * n))];
  while (centres.length < Math.min(k, n)) {
    const d = Array.from({ length: n }, (_, i) => Math.min(...centres.map((c) => dist(at(i), c))));
    const total = d.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let pick = rand() * total, i = 0;
    while (i < n - 1 && (pick -= d[i]) > 0) i++;
    centres.push(at(i));
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iterations; it++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const p = at(i);
      let best = 0, bestD = Infinity;
      centres.forEach((c, j) => { const dd = dist(p, c); if (dd < bestD) { bestD = dd; best = j; } });
      assign[i] = best;
      sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2]; sums[best][3]++;
    }
    centres.forEach((c, j) => { if (sums[j][3]) { c[0] = sums[j][0] / sums[j][3]; c[1] = sums[j][1] / sums[j][3]; c[2] = sums[j][2] / sums[j][3]; } });
  }
  const counts = centres.map(() => 0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;
  const hex = (c: number[]) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
  return centres.map((c, j) => ({ hex: hex(c), share: Math.round((counts[j] / n) * 1000) / 1000 })).filter((c) => c.share > 0).sort((a, b) => b.share - a.share);
}
