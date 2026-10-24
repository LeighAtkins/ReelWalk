/**
 * The zoom (radial) blur of the speed-ramp transition (ADR 0074), as the
 * plan for one SVG filter. Pure: a function of the blur's spread and its
 * focus, so preview and export build the same filter.
 *
 * Technique. A zoom blur is the picture averaged over a stack of copies
 * scaled about the focus (the streaks radiate from it). SVG has no "scale"
 * primitive, but `feDisplacementMap` moves each pixel by an amount read from a
 * map image, and a map whose red and green ramp linearly with x and y moves
 * every pixel in proportion to its distance from the point where the ramps
 * read 0.5: that is a scale about that point. The filter reads the ramp map
 * (one small PNG through `feImage`) and builds the stack by doubling, the way
 * a box blur is built from repeated half-sums: each stage averages the
 * picture so far with a copy of itself magnified a little more, so S stages
 * give 2^S equally spaced copies (8 for 3 stages) for S displacements and S
 * `feComposite` averages, not 2^S of each. Stage s magnifies by
 * spread·2^s / (2^S − 1), so the copies span 0 to `spread` in equal steps.
 *
 * One filter per stage, chained in the CSS `filter` property (`url(#a-z0) url(#a-z1) …`):
 * inside one filter every reference to an earlier result is evaluated again (Skia does not
 * share the node), so doubling in a single filter costs 2^S evaluations of the source and
 * took 3 to 4 s a frame at 3 stages; chained, each stage reads the one before as a finished
 * layer and the cost is linear (about 0.4 s a stage at 1080×1920 in software GL).
 *
 * The copies are all *magnified* (the sample point moves toward the focus), so
 * none ever reads outside the frame and the border never goes clear, and the
 * average sits a little larger than the sharp frame, which is the push-in's own
 * direction: the blur and the push reinforce each other and never pull apart.
 *
 * The ramp's slope is 1/D of a pixel, D = twice the farthest corner distance
 * on the larger axis, so both channels fit 0..1 whatever the focus; the
 * displacement scale of a stage that magnifies by k is then -k·D.
 */
import { REEL_FORMAT } from "@reelwalk/core";

/** Most stages: 3 is 8 copies (a gap of a seventh of the spread between neighbours, about 9 px at the edge at the default). */
export const ZOOM_STAGES = { min: 1, max: 3 } as const;
/** About one stage per this much spread, so the gap between neighbours stays under about 10 px at the edge. */
const STAGE_SPREAD = [0.03, 0.08] as const;

/** How many stages a blur of `spread` takes: 1 (2 copies) for a faint one, 3 (8 copies) for the full spread. */
export function zoomBlurStageCount(spread: number): number {
  return Math.min(ZOOM_STAGES.max, Math.max(ZOOM_STAGES.min, 1 + STAGE_SPREAD.filter((limit) => spread > limit).length));
}

/** Each stage's magnification and the share of its displaced copy in the average (a half: the copies end up equally weighted). */
export function zoomBlurStages(spread: number): { k: number; mix: number }[] {
  const stages = zoomBlurStageCount(spread);
  return Array.from({ length: stages }, (_, s) => ({ k: (spread * 2 ** s) / (2 ** stages - 1), mix: 0.5 }));
}

/** The magnifications of the copies the stages add up to, sharp one first (for tests and the ADR's figures). */
export function zoomBlurCopies(spread: number): number[] {
  let copies = [0];
  for (const stage of zoomBlurStages(spread)) copies = [...copies, ...copies.map((k) => k + stage.k)];
  return copies.sort((x, y) => x - y);
}

/** The average position of the copies, as a magnification: how much larger than the sharp frame the blurred picture sits on average (the push it adds). */
export function zoomBlurMeanScale(spread: number): number {
  const copies = zoomBlurCopies(spread);
  return copies.reduce((sum, k) => sum + k, 0) / copies.length;
}

export type ZoomMap = { /** Pixels per full channel range. */ range: number; x: [number, number]; y: [number, number] };

/** The ramp map's channel values at the left/top and right/bottom edge for a focus (frame fractions): 0.5 at the focus. */
export function zoomMapRamps(fx: number, fy: number, width: number = REEL_FORMAT.width, height: number = REEL_FORMAT.height): ZoomMap {
  const cx = fx * width, cy = fy * height;
  const range = 2 * Math.max(cx, width - cx, cy, height - cy, 1);
  const ramp = (focus: number, size: number): [number, number] => [0.5 - focus / range, 0.5 + (size - focus) / range];
  return { range, x: ramp(cx, width), y: ramp(cy, height) };
}

const to8 = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);

/** The ramp map is this many texels; the filter stretches it over the frame and the sampler interpolates. */
const MAP_W = 54, MAP_H = 96;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/** An RGB PNG with no compression (stored deflate blocks): the map is a few KB and this needs no zlib, in the browser or in Node. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const rows = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const blocks: number[] = [0x78, 0x01];
  for (let at = 0; at < rows.length; at += 65535) {
    const length = Math.min(65535, rows.length - at);
    blocks.push(at + length >= rows.length ? 1 : 0, length & 255, length >> 8, ~length & 255, (~length >> 8) & 255);
    for (let i = 0; i < length; i++) blocks.push(rows[at + i]);
  }
  const sum = adler32(rows);
  blocks.push(sum >>> 24, (sum >>> 16) & 255, (sum >>> 8) & 255, sum & 255);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height);
  header[8] = 8; header[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", Uint8Array.from(blocks)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { png.set(part, at); at += part.length; }
  return png;
}

/** The ramp map's pixels: red = 0.5 + (x − focus) / range across, green the same down. */
export function zoomMapPixels(map: ZoomMap): Uint8Array {
  const rgb = new Uint8Array(MAP_W * MAP_H * 3);
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const i = (y * MAP_W + x) * 3;
    rgb[i] = to8(map.x[0] + ((map.x[1] - map.x[0]) * (x + 0.5)) / MAP_W);
    rgb[i + 1] = to8(map.y[0] + ((map.y[1] - map.y[0]) * (y + 0.5)) / MAP_H);
  }
  return rgb;
}

const mapUris = new Map<string, string>();

/** The map as a data-URI PNG (memoised by focus): a bitmap, which the filter reads far faster than an SVG gradient (35 ms against about 200 ms a copy measured). */
function mapUri(fx: number, fy: number, width: number, height: number): string {
  const key = `${fx},${fy},${width},${height}`;
  let uri = mapUris.get(key);
  if (!uri) {
    const png = encodePng(MAP_W, MAP_H, zoomMapPixels(zoomMapRamps(fx, fy, width, height)));
    let binary = "";
    for (const byte of png) binary += String.fromCharCode(byte);
    uri = `data:image/png;base64,${btoa(binary)}`;
    mapUris.set(key, uri);
  }
  return uri;
}

/** The focus rounded to a hundredth, so the map's data URI repeats frame to frame and between the two sides of a cut. */
export const roundFocus = (value: number) => Math.round(Math.min(0.8, Math.max(0.2, value)) * 100) / 100;

export type ZoomFilterSpec = {
  width: number;
  height: number;
  /** The displacement map: a small PNG, red and green ramping across and down, stretched over the frame. */
  map: string;
  /** One entry per stage, in order: the displacement scale of its copy and the average's weights (keep + add = 1). */
  stages: { scale: number; keep: number; add: number }[];
};

/** Everything the filter's primitives take: the ramp map and, per stage, its displacement scale and averaging weights. */
export function zoomFilterSpec(spread: number, fx: number, fy: number, width: number = REEL_FORMAT.width, height: number = REEL_FORMAT.height): ZoomFilterSpec {
  const focusX = roundFocus(fx), focusY = roundFocus(fy);
  const range = zoomMapRamps(focusX, focusY, width, height).range;
  return { width, height, map: mapUri(focusX, focusY, width, height), stages: zoomBlurStages(spread).map((stage) => ({ scale: -stage.k * range, keep: 1 - stage.mix, add: stage.mix })) };
}

/** The id of stage `s` of the zoom blur filter `id`: one filter per stage, chained in CSS (`filter: url(#a) url(#b) …`). */
export const zoomStageId = (id: string, s: number) => `${id}-z${s}`;
