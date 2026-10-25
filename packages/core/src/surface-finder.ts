/**
 * "Put text on a surface" (ADR 0075): propose the flat surfaces in a frame a
 * title could be painted on (a wall, the floor, a ceiling, a band of sky,
 * snow or lawn, a tabletop, a window), ranked by size, by whether the tracker
 * could follow them, and by how well a line of type would sit on them. The
 * author taps one; its corners become the title's `surface` and the existing
 * tracker (ADR 0052) follows it.
 *
 * Pure arithmetic on a `Gray` frame. Two sources of candidates are fused:
 *
 * - **Regions** a vision model labelled (`surface-regions.ts` is the prompt and
 *   the parser): rough quads with a kind. Their sides are snapped onto real
 *   straight edges found in the picture (a gradient-guided Hough transform,
 *   `surface.ts`) so the perspective is the wall's own, not a guess; a
 *   floor or ground region the model drew as a plain box is given the
 *   converging sides a ground plane has, from the horizon.
 * - **Geometry alone**, when there is no model (or it missed something): quads
 *   built from the strongest pairs of near-vertical and near-horizontal edges,
 *   plus smooth bands at the top (sky, ceiling) and bottom (snow, floor).
 *
 * Every candidate is then measured the way the tracker will see it: the
 * features inside it (the tracker's own corner score and spread rule), the
 * size of the plane, how steeply it is seen, whether the title fits at a
 * legible size inside the safe area, and which ink reads on it.
 */
import { applyHomography, homography, type Gray, type Quad } from "./motion";
import { edgePoints, houghLines, lineIntersection, type SurfaceLine } from "./surface";
import { buildPyramid, downsample, insideQuad, quadCoverage, quadIsSane, supportPoints } from "./track";
import { estimateLineWidth } from "./cinematic";
import { TITLE_LEADING } from "./scene";
import { REEL_FORMAT } from "./timeline";

export const SURFACE_KINDS = ["wall", "floor", "ceiling", "sky", "tabletop", "ground", "window", "other"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** A region a vision model named: four corners (tl, tr, br, bl) as fractions of the picture. */
export type SurfaceRegion = {
  kind: SurfaceKind;
  quad: number[];
  /** 0–1: how sure the model is that this is one flat surface of that kind. */
  confidence: number;
  /** False when something (a person, furniture, plants) covers a good part of it. */
  clear?: boolean;
  note?: string;
};

export type SurfaceHints = {
  regions?: readonly SurfaceRegion[];
  /** Where the horizon is (fraction of the picture's height), if the model saw one. */
  horizonY?: number | null;
};

/** The title being placed: only its shape matters to the finder. */
export type SurfaceText = {
  /** Width over height of one set of the title's lines (see `titleAspect`). */
  aspect: number;
};

export type SurfaceCandidate = {
  id: string;
  kind: SurfaceKind;
  /** Short words for the sheet: "Wall", "Sky", "Floor". */
  label: string;
  /** Where the candidate came from: a labelled region, edges in the picture, or a smooth band. */
  source: "vision" | "lines" | "band";
  /** The whole surface as corners (tl, tr, br, bl), fractions of the frame. Features are taken from here when tracking. */
  plane: number[];
  /** The corners the title fills (fractions): a title-shaped rectangle in the plane's own perspective. This becomes `text.surface`. */
  placement: number[];
  /** Share of the frame the plane covers. */
  area: number;
  /** What the tracker will find: features inside the plane, and how widely they spread over the title. */
  texture: { points: number; coverage: number };
  /** "surface": the tracker can follow it. "fixed": it has no detail to follow (sky, a blank wall); place it, do not track it. */
  tracking: "surface" | "fixed";
  /** 0–1 each, and the weighted total the list is sorted by. */
  scores: { size: number; texture: number; fit: number; total: number };
  /** The ink that reads on the surface under the title. */
  ink: { color: string; shadow: "soft" | "strong"; luminance: number; contrast: number };
  /** Plain words about why it ranks where it does. */
  reasons: string[];
};

export type SurfaceSearch = {
  candidates: SurfaceCandidate[];
  /** Surfaces considered and turned down, with the reason (for agents and for tuning). */
  rejected: { kind: SurfaceKind; source: SurfaceCandidate["source"]; plane: number[]; reason: string }[];
  horizonY: number | null;
  /** How many straight edges the geometry found; none means a flat or soft picture. */
  lines: number;
};

export type SurfaceOptions = {
  /** How many to return (default 3). */
  top?: number;
  /** Keep candidates the tracker cannot follow (default true: they are offered as "fixed"). */
  keepFixed?: boolean;
};

const FRAME = REEL_FORMAT;
const UNIT: Quad = [0, 0, 1, 0, 1, 1, 0, 1];
/** Where a title may sit: clear of the frame edge and of the strip Instagram's captions cover. */
export const SURFACE_SAFE = { left: 0.035, right: 0.965, top: 0.07, bottom: 0.86 };
/** The shortest a line of type may be drawn, composition px (≈2.9% of the frame's height). */
export const SURFACE_MIN_LINE_PX = 52;
/** The tracker's own start gate (ADR 0052): features found inside the support, spread over this much of the title. */
const MIN_POINTS = 8, MIN_COVERAGE = 0.25;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round4 = (v: number) => Number(v.toFixed(4));
const angleGap = (a: number, b: number) => { const d = Math.abs(((a - b) % Math.PI + Math.PI) % Math.PI); return Math.min(d, Math.PI - d); };

// ---------------------------------------------------------------- the title's shape

/**
 * Width over height of a title set in the house serif (the "elegant" style,
 * Cormorant Garamond, 0.06 em of letter spacing): the widest line over the
 * stack of lines, from the renderer's measured advances. A planar title fills
 * the quad it is given, so the quad must have this shape to be the size meant.
 */
export function titleAspect(text: string, { tracking = 0.06, fontFamily = "Cormorant Garamond Variable", fontWeight = 600 }: { tracking?: number; fontFamily?: string; fontWeight?: number } = {}): number {
  const lines = (text || " ").split("\n");
  const size = 100;
  const widest = Math.max(...lines.map((line) => estimateLineWidth(line || " ", { fontFamily, fontWeight, fontSize: size, letterSpacing: tracking })));
  return Math.max(0.5, widest / (size * TITLE_LEADING * lines.length));
}

// ---------------------------------------------------------------- small geometry

const signedArea = (q: readonly number[]) => {
  let a = 0;
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; a += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1]; }
  return a / 2;
};

/** Convex with consistent winding. */
function isConvex(q: readonly number[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = q[((i + 1) % 4) * 2] - q[i * 2], ay = q[((i + 1) % 4) * 2 + 1] - q[i * 2 + 1];
    const bx = q[((i + 2) % 4) * 2] - q[((i + 1) % 4) * 2], by = q[((i + 2) % 4) * 2 + 1] - q[((i + 1) % 4) * 2 + 1];
    const c = ax * by - ay * bx;
    if (Math.abs(c) < 1e-9) return false;
    if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

/** The smallest interior angle of the quad, degrees. */
function minAngle(q: readonly number[]): number {
  let min = 180;
  for (let i = 0; i < 4; i++) {
    const p = [q[i * 2], q[i * 2 + 1]], a = [q[((i + 3) % 4) * 2], q[((i + 3) % 4) * 2 + 1]], b = [q[((i + 1) % 4) * 2], q[((i + 1) % 4) * 2 + 1]];
    const u = [a[0] - p[0], a[1] - p[1]], v = [b[0] - p[0], b[1] - p[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) || 1);
    min = Math.min(min, (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI);
  }
  return min;
}

/** Order four corners tl, tr, br, bl by angle about their centre. */
export function orderSurfaceCorners(points: readonly [number, number][]): Quad {
  const cx = points.reduce((s, p) => s + p[0], 0) / 4, cy = points.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
  return [0, 1, 2, 3].flatMap((i) => sorted[(start + i) % 4]) as Quad;
}

/** Overlap of two quads (fractions) as intersection over union, sampled on a grid. */
export function surfaceOverlap(a: readonly number[], b: readonly number[]): number {
  const cols = 30, rows = 54;
  let inter = 0, union = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = (i + 0.5) / cols, y = (j + 0.5) / rows;
    const inA = insideQuad(a as Quad, x, y, 0), inB = insideQuad(b as Quad, x, y, 0);
    if (inA || inB) union++;
    if (inA && inB) inter++;
  }
  return union ? inter / union : 0;
}

/** Share of the frame a quad (fractions) covers. */
function frameShare(q: readonly number[]): number {
  const cols = 30, rows = 54;
  let n = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (insideQuad(q as Quad, (i + 0.5) / cols, (j + 0.5) / rows, 0)) n++;
  return n / (cols * rows);
}

/** Composition px size of the plane's own rectangle: the mean of its opposite edges (as the renderer reads it, scene.ts). */
export function surfacePlaneSize(plane: readonly number[]): { width: number; height: number } {
  const px = (i: number) => plane[i * 2] * FRAME.width, py = (i: number) => plane[i * 2 + 1] * FRAME.height;
  const edge = (a: number, b: number) => Math.hypot(px(b) - px(a), py(b) - py(a));
  return { width: (edge(0, 1) + edge(3, 2)) / 2, height: (edge(0, 3) + edge(1, 2)) / 2 };
}

const toPx = (q: readonly number[]): Quad => q.map((v, i) => (i % 2 === 0 ? v * FRAME.width : v * FRAME.height)) as Quad;

// ---------------------------------------------------------------- placing the title inside the plane

/**
 * A rectangle of the title's shape inside the plane, mapped through the plane's
 * own perspective (so it is the wall's rectangle, not a screen-aligned box).
 * Centred on the middle of the part of the plane that is on screen and clear
 * of the edge and the caption strip, as wide as the plane comfortably takes
 * (84% of its width, 80% of its height) and shrunk until all four corners sit
 * inside the safe area. Null when no legible size fits.
 */
export function fitTitleOnPlane(plane: readonly number[], aspect: number, safe = SURFACE_SAFE): { quad: number[]; lineHeightPx: number } | null {
  const H = homography(UNIT, toPx(plane));
  if (!H) return null;
  const { width: Wl, height: Hl } = surfacePlaneSize(plane);
  if (Wl < 20 || Hl < 20) return null;
  // The visible middle of the plane, in its own coordinates.
  let su = 0, sv = 0, n = 0;
  for (let j = 0; j < 14; j++) for (let i = 0; i < 14; i++) {
    const u = (i + 0.5) / 14, v = (j + 0.5) / 14;
    const [x, y] = applyHomography(H, u, v);
    const fx = x / FRAME.width, fy = y / FRAME.height;
    if (fx < safe.left || fx > safe.right || fy < safe.top || fy > safe.bottom) continue;
    su += u; sv += v; n++;
  }
  if (n < 6) return null;
  const cu = su / n, cv = sv / n;
  let tw = Math.min(0.84 * Wl, 0.8 * Hl * aspect);
  for (let attempt = 0; attempt < 14; attempt++, tw *= 0.92) {
    const th = tw / aspect;
    const hu = tw / (2 * Wl), hv = th / (2 * Hl);
    const corners = ([[cu - hu, cv - hv], [cu + hu, cv - hv], [cu + hu, cv + hv], [cu - hu, cv + hv]] as [number, number][]).map(([u, v]) => applyHomography(H, u, v));
    const frac = corners.map(([x, y]) => [x / FRAME.width, y / FRAME.height]);
    if (frac.some(([x, y]) => x < safe.left || x > safe.right || y < safe.top || y > safe.bottom)) continue;
    const quad = frac.flat();
    // How tall a line of type is, as it will be drawn: the mean of the left and right edges.
    const lineHeightPx = (Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]) + Math.hypot(corners[2][0] - corners[1][0], corners[2][1] - corners[1][1])) / 2;
    if (lineHeightPx < SURFACE_MIN_LINE_PX * 0.75) return null;
    return { quad: quad.map(round4), lineHeightPx };
  }
  return null;
}

// ---------------------------------------------------------------- ink

const relative = (gray: number) => {
  const c = gray / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const IVORY = { color: "#f4eee2", gray: 238 }, DEEP = { color: "#1b1915", gray: 27 };
const contrastOf = (a: number, b: number) => { const la = relative(a), lb = relative(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

/**
 * The ink for a title painted on the picture under `quad` (fractions): ivory
 * on darker surfaces, deep brown-black on lighter ones, whichever contrasts
 * more with the surface's mean grey. A mixed or low-contrast surface gets the
 * strong shadow (the house rule for type on a busy picture).
 */
export function surfaceInk(gray: Gray, quad: readonly number[]): SurfaceCandidate["ink"] {
  const px = quad.map((v, i) => (i % 2 === 0 ? v * gray.width : v * gray.height));
  const h = homography(UNIT, px as Quad);
  let sum = 0, sum2 = 0, n = 0;
  if (h) for (let j = 0; j < 10; j++) for (let i = 0; i < 16; i++) {
    const [x, y] = applyHomography(h, (i + 0.5) / 16, (j + 0.5) / 10);
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= gray.width || yi >= gray.height) continue;
    const v = gray.data[yi * gray.width + xi];
    sum += v; sum2 += v * v; n++;
  }
  const mean = n ? sum / n : 128, sd = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;
  const ivory = contrastOf(mean, IVORY.gray), deep = contrastOf(mean, DEEP.gray);
  const ink = ivory >= deep ? IVORY : DEEP;
  const contrast = Math.max(ivory, deep);
  return { color: ink.color, shadow: contrast < 4.5 || sd > 32 ? "strong" : "soft", luminance: round4(mean / 255), contrast: Number(contrast.toFixed(2)) };
}

// ---------------------------------------------------------------- edges and lines

type EdgeMap = { width: number; height: number; hit: Uint8Array; dir: Float32Array; gray: Gray };

function buildEdgeMap(points: { x: number; y: number; dir: number }[], gray: Gray): EdgeMap {
  const { width, height } = gray;
  const hit = new Uint8Array(width * height), dir = new Float32Array(width * height);
  for (const p of points) { const i = p.y * width + p.x; hit[i] = 1; dir[i] = p.dir; }
  return { width, height, hit, dir, gray };
}

/** The gradient magnitude above which the strongest ~11% of pixels sit, clamped so a flat or a noisy frame still gives sane edges. */
function gradientThreshold(gray: Gray): number {
  const { data, width, height } = gray;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const gx = data[i + 1] - data[i - 1] + 0.5 * (data[i - width + 1] - data[i - width - 1] + data[i + width + 1] - data[i + width - 1]);
    const gy = data[i + width] - data[i - width] + 0.5 * (data[i + width - 1] - data[i - width - 1] + data[i + width + 1] - data[i - width + 1]);
    hist[Math.min(255, Math.round(Math.hypot(gx, gy)))]++; n++;
  }
  let acc = 0, level = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.11) { level = v; break; } }
  return clamp(level, 14, 48);
}

/**
 * Fraction of the stretch of segment a→b that lies on a real edge (one running the same way), how much of it is on screen,
 * and `step`: how different the picture is on its two sides (grey levels, the mean over the stretch of the strip each
 * side minus the other). A boundary between two surfaces has a step; a mortar line or a plank seam, which is an edge
 * with the same wall either side, has none.
 */
function sideSupport(map: EdgeMap, ax: number, ay: number, bx: number, by: number): { support: number; visible: number; step: number } {
  const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
  if (length < 4) return { support: 0, visible: 0, step: 0 };
  const nx = -dy / length, ny = dx / length;
  const at = (x: number, y: number) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= map.width || yi >= map.height ? NaN : map.gray.data[yi * map.width + xi]; };
  let stepSum = 0, stepN = 0;
  const normal = Math.atan2(dx, -dy);
  const samples = clamp(Math.round(length / 2.5), 10, 120);
  let used = 0, hits = 0;
  for (let k = 0; k < samples; k++) {
    const t = (k + 0.5) / samples, x = ax + dx * t, y = ay + dy * t;
    if (x < 2 || y < 2 || x > map.width - 3 || y > map.height - 3) continue;
    used++;
    let left = 0, right = 0, n = 0;
    for (const d of [3, 5, 7]) { const a = at(x + nx * d, y + ny * d), b = at(x - nx * d, y - ny * d); if (!Number.isNaN(a) && !Number.isNaN(b)) { left += a; right += b; n++; } }
    if (n) { stepSum += (left - right) / n; stepN++; }
    const xi = Math.round(x), yi = Math.round(y);
    let found = false;
    for (let j = -1; j <= 1 && !found; j++) for (let i = -1; i <= 1; i++) {
      const idx = (yi + j) * map.width + (xi + i);
      if (map.hit[idx] && angleGap(map.dir[idx], normal) <= 0.55) { found = true; break; }
    }
    if (found) hits++;
  }
  return { support: used ? hits / used : 0, visible: used / samples, step: stepN ? Math.abs(stepSum / stepN) : 0 };
}

function lineOf(ax: number, ay: number, bx: number, by: number): SurfaceLine | null {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  let theta = Math.atan2(dx / len, -dy / len);
  theta = ((theta % Math.PI) + Math.PI) % Math.PI;
  return { theta, rho: ax * Math.cos(theta) + ay * Math.sin(theta), votes: 0 };
}
const distanceTo = (l: SurfaceLine, x: number, y: number) => Math.abs(x * Math.cos(l.theta) + y * Math.sin(l.theta) - l.rho);
const xAt = (l: SurfaceLine, y: number) => (Math.abs(Math.cos(l.theta)) < 1e-6 ? NaN : (l.rho - y * Math.sin(l.theta)) / Math.cos(l.theta));
const yAt = (l: SurfaceLine, x: number) => (Math.abs(Math.sin(l.theta)) < 1e-6 ? NaN : (l.rho - x * Math.cos(l.theta)) / Math.sin(l.theta));
const isUpright = (l: SurfaceLine) => angleGap(l.theta, 0) <= (25 * Math.PI) / 180;
const isLevelish = (l: SurfaceLine) => angleGap(l.theta, 0) >= (50 * Math.PI) / 180;

/**
 * Where the horizon is, from the picture's own straight edges: lines that run
 * away from the camera meet on it, so the y at which pairs of non-upright
 * lines cross most often (weighted by how strong each is) is the horizon.
 * Null when no height gathers enough crossings.
 */
export function estimateHorizon(lines: readonly SurfaceLine[], width: number, height: number): { y: number; vpx: number | null; strength: number } | null {
  // Anything more than 10° off upright can recede: floorboards seen straight on are steep, skirting boards shallow.
  const level = lines.filter((l) => angleGap(l.theta, 0) >= (10 * Math.PI) / 180);
  if (level.length < 3) return null;
  const bins = 60;
  const lo = -1 * height, hi = 2 * height;
  const weight = new Float64Array(bins);
  const xs: { x: number; y: number; w: number }[] = [];
  for (let i = 0; i < level.length; i++) for (let j = i + 1; j < level.length; j++) {
    // Nearly parallel lines meet far away and tell nothing; lines at the same angle meet nowhere.
    if (angleGap(level[i].theta, level[j].theta) < (7 * Math.PI) / 180) continue;
    const p = lineIntersection(level[i], level[j]);
    if (!p || !Number.isFinite(p[0]) || p[1] < lo || p[1] > hi || Math.abs(p[0]) > 8 * width) continue;
    const w = Math.sqrt(Math.max(1, level[i].votes) * Math.max(1, level[j].votes));
    weight[Math.min(bins - 1, Math.floor(((p[1] - lo) / (hi - lo)) * bins))] += w;
    xs.push({ x: p[0], y: p[1], w });
  }
  const smoothed = (b: number) => (weight[b - 1] ?? 0) * 0.5 + weight[b] + (weight[b + 1] ?? 0) * 0.5;
  let best = 0;
  for (let b = 1; b < bins; b++) if (smoothed(b) > smoothed(best)) best = b;
  const total = weight.reduce((s, v) => s + v, 0);
  const near = weight[best] + (weight[best - 1] ?? 0) + (weight[best + 1] ?? 0);
  if (total <= 0 || near < total * 0.35 || near < 60) return null;
  const binCentre = lo + ((best + 0.5) / bins) * (hi - lo);
  const band = xs.filter((p) => Math.abs(p.y - binCentre) <= ((hi - lo) / bins) * 1.5);
  const bandWeight = band.reduce((s, p) => s + p.w, 0);
  // Where the crossings in that band actually are, not the middle of the bin.
  const centre = bandWeight > 0 ? band.reduce((sum, p) => sum + p.y * p.w, 0) / bandWeight : binCentre;
  // A vanishing point on that line: where the crossings agree, if they do.
  let vpx: number | null = null;
  if (band.length >= 3) {
    const sorted = [...band].sort((a, b) => a.x - b.x);
    let acc = 0;
    for (const p of sorted) { acc += p.w; if (acc >= bandWeight / 2) { vpx = p.x / width; break; } }
  }
  return { y: centre / height, vpx, strength: near / total };
}

// ---------------------------------------------------------------- snapping a rough quad onto real edges

/**
 * Pull each side of a quad (picture px) onto the straight edge that really
 * bounds the surface: the strongest line near it, running the same way, that
 * a good part of the side lies along. A corner never moves further than 10%
 * of the frame; a side with no edge near keeps its own line.
 */
export function snapQuadToEdges(quad: Quad, lines: readonly SurfaceLine[], map: EdgeMap): { quad: Quad; snapped: number } {
  const w = map.width, h = map.height, tol = 0.06 * Math.min(w, h);
  const own: (SurfaceLine | null)[] = [], chosen: (SurfaceLine | null)[] = [];
  let snapped = 0;
  for (let i = 0; i < 4; i++) {
    const a = [quad[i * 2], quad[i * 2 + 1]], b = [quad[((i + 1) % 4) * 2], quad[((i + 1) % 4) * 2 + 1]];
    const mine = lineOf(a[0], a[1], b[0], b[1]);
    own.push(mine);
    let best: { line: SurfaceLine; value: number } | null = null;
    for (const l of lines) {
      if (!mine || angleGap(l.theta, mine.theta) > (10 * Math.PI) / 180) continue;
      const da = distanceTo(l, a[0], a[1]), db = distanceTo(l, b[0], b[1]);
      if (da > tol || db > tol) continue;
      // The stretch of the edge between the side's own endpoints, projected onto the candidate line.
      const along = (px: number, py: number): [number, number] => { const d = px * Math.cos(l.theta) + py * Math.sin(l.theta) - l.rho; return [px - d * Math.cos(l.theta), py - d * Math.sin(l.theta)]; };
      const pa = along(a[0], a[1]), pb = along(b[0], b[1]);
      const { support } = sideSupport(map, pa[0], pa[1], pb[0], pb[1]);
      const value = support * (1 - 0.4 * ((da + db) / (2 * tol)));
      if (support >= 0.45 && (!best || value > best.value)) best = { line: l, value };
    }
    chosen.push(best ? best.line : mine);
    if (best) snapped++;
  }
  const maxMove = 0.1 * Math.max(w, h);
  const out = [...quad] as Quad;
  for (let i = 0; i < 4; i++) {
    const prev = chosen[(i + 3) % 4], next = chosen[i];
    if (!prev || !next) continue;
    const p = lineIntersection(prev, next);
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (Math.hypot(p[0] - quad[i * 2], p[1] - quad[i * 2 + 1]) <= maxMove) { out[i * 2] = p[0]; out[i * 2 + 1] = p[1]; }
  }
  return { quad: out, snapped };
}

// ---------------------------------------------------------------- ground planes

/**
 * A floor, ceiling or ground region drawn as a plain box has parallel sides;
 * the real surface's sides run away from the camera to a point on the horizon.
 * When the box is nearly a rectangle (its top and bottom widths within 8%), its near edge is
 * kept and its far edge is moved in along lines to the vanishing point (x
 * `vpx`, y `horizon`), so the corners convergeToHorizon like the surface does. A box
 * that already converges, or that crosses the horizon, is left alone.
 */
export function convergeToHorizon(quad: readonly number[], horizon: number, vpx = 0.5): number[] | null {
  const [tlx, tly, trx, try_, brx, bry, blx, bly] = quad;
  const top = (tly + try_) / 2, bottom = (bly + bry) / 2;
  if (Math.abs(bottom - top) < 0.05) return null;
  const topWidth = Math.abs(trx - tlx), bottomWidth = Math.abs(brx - blx);
  if (Math.abs(topWidth - bottomWidth) > 0.08 * Math.max(topWidth, bottomWidth)) return null;
  // The near edge is the one furthest from the horizon; both must be on the same side of it.
  const dTop = top - horizon, dBottom = bottom - horizon;
  if (dTop * dBottom <= 0 || Math.min(Math.abs(dTop), Math.abs(dBottom)) < 0.03) return null;
  const nearIsBottom = Math.abs(dBottom) > Math.abs(dTop);
  const ratio = nearIsBottom ? dTop / dBottom : dBottom / dTop;
  if (ratio <= 0.1) return null;
  const project = (x: number) => vpx + (x - vpx) * ratio;
  const out = nearIsBottom
    ? [project(blx), top, project(brx), top, brx, bottom, blx, bottom]
    // A ceiling: the near edge is the top one.
    : [tlx, top, trx, top, project(trx), bottom, project(tlx), bottom];
  const moved = Math.max(...out.map((v, i) => Math.abs(v - quad[i])));
  return moved <= 0.32 ? out.map(round4) : null;
}

/**
 * How much of a strong straight edge runs across the inside of a quad (picture
 * px): a door frame, the line where two walls meet, a window's sill. A surface
 * to paint on is one piece; an edge across it means the quad spans two things.
 * The longest well-supported chord of any strong line through the quad (shrunk
 * 20% about its centre, so its own sides do not count), as a share of the
 * quad's diagonal, plus half the second longest.
 */
export function interiorClutter(quad: Quad, lines: readonly SurfaceLine[], map: EdgeMap): number {
  const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  const inset = quad.map((v, i) => (i % 2 === 0 ? cx + (v - cx) * 0.8 : cy + (v - cy) * 0.8)) as Quad;
  const diagonal = Math.hypot(Math.max(quad[0], quad[2], quad[4], quad[6]) - Math.min(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7]) - Math.min(quad[1], quad[3], quad[5], quad[7]));
  if (diagonal < 8) return 0;
  const reach = Math.hypot(map.width, map.height);
  const chords: number[] = [];
  for (const l of lines.slice(0, 32)) {
    const ox = l.rho * Math.cos(l.theta), oy = l.rho * Math.sin(l.theta), dx = -Math.sin(l.theta), dy = Math.cos(l.theta);
    let first = NaN, last = NaN;
    for (let t = -reach; t <= reach; t += 1.5) if (insideQuad(inset, ox + dx * t, oy + dy * t, 0)) { if (Number.isNaN(first)) first = t; last = t; }
    if (Number.isNaN(first)) continue;
    const length = last - first;
    if (length < 0.3 * diagonal) continue;
    const { support, step } = sideSupport(map, ox + dx * first, oy + dy * first, ox + dx * last, oy + dy * last);
    if (support >= 0.55 && step >= 20) chords.push((length / diagonal) * support);
  }
  chords.sort((a, b) => b - a);
  return (chords[0] ?? 0) + 0.5 * (chords[1] ?? 0);
}

// ---------------------------------------------------------------- candidates from edges alone

type Raw = { kind: SurfaceKind; source: SurfaceCandidate["source"]; plane: number[]; clear: boolean; prior: number; note?: string; snapped?: number; label?: string };

/** Quads bounded by pairs of upright and pairs of level edges, kept when the edges are really there along most of each side. */
function lineQuads(lines: readonly SurfaceLine[], map: EdgeMap, horizon: number | null): Raw[] {
  const w = map.width, h = map.height;
  const V = lines.filter(isUpright).slice(0, 10), Hh = lines.filter(isLevelish).slice(0, 10);
  const found: { quad: Quad; value: number }[] = [];
  for (let a = 0; a < V.length; a++) for (let b = a + 1; b < V.length; b++) {
    const xa = xAt(V[a], h / 2), xb = xAt(V[b], h / 2);
    if (!Number.isFinite(xa) || !Number.isFinite(xb)) continue;
    const [L, R] = xa < xb ? [V[a], V[b]] : [V[b], V[a]];
    if (Math.abs(xa - xb) < 0.16 * w) continue;
    for (let c = 0; c < Hh.length; c++) for (let d = c + 1; d < Hh.length; d++) {
      const ya = yAt(Hh[c], w / 2), yb = yAt(Hh[d], w / 2);
      if (!Number.isFinite(ya) || !Number.isFinite(yb) || Math.abs(ya - yb) < 0.07 * h) continue;
      const [T, B] = ya < yb ? [Hh[c], Hh[d]] : [Hh[d], Hh[c]];
      const corners = [lineIntersection(L, T), lineIntersection(R, T), lineIntersection(R, B), lineIntersection(L, B)];
      if (corners.some((p) => !p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
      const quad = corners.flatMap((p) => p as [number, number]) as Quad;
      if (!isConvex(quad) || !quadIsSane(quad, 20)) continue;
      if (quad.some((v, i) => (i % 2 === 0 ? v < -0.12 * w || v > 1.12 * w : v < -0.12 * h || v > 1.12 * h))) continue;
      const share = frameShare(quad.map((v, i) => (i % 2 === 0 ? v / w : v / h)));
      if (share < 0.05 || share > 0.88) continue;
      const sides = [0, 1, 2, 3].map((i) => sideSupport(map, quad[i * 2], quad[i * 2 + 1], quad[((i + 1) % 4) * 2], quad[((i + 1) % 4) * 2 + 1]));
      // A side that runs off screen is not held against the quad; the rest must be really there.
      const known = sides.filter((s) => s.visible >= 0.25);
      if (known.length < 3 || known.some((s) => s.support < 0.5 || s.step < 12) || known.reduce((sum, x) => sum + x.support, 0) / known.length < 0.62) continue;
      const value = (known.reduce((s, x) => s + x.support, 0) / known.length) * (0.5 + Math.sqrt(share));
      found.push({ quad, value });
    }
  }
  found.sort((p, q) => q.value - p.value);
  const kept: { quad: Quad; value: number }[] = [];
  for (const f of found) {
    const fractions = f.quad.map((v, i) => (i % 2 === 0 ? v / w : v / h));
    if (kept.every((k) => surfaceOverlap(k.quad.map((v, i) => (i % 2 === 0 ? v / w : v / h)), fractions) < 0.55)) kept.push(f);
    if (kept.length >= 6) break;
  }
  return kept.map((k) => {
    const plane = k.quad.map((v, i) => round4(i % 2 === 0 ? v / w : v / h));
    return { kind: guessKind(plane, horizon), source: "lines" as const, plane, clear: true, prior: 0 };
  });
}

/** What a line-bounded quad probably is, from where it sits against the horizon (or, with none, a wall). */
function guessKind(plane: readonly number[], horizon: number | null): SurfaceKind {
  if (horizon === null) return "wall";
  const ys = [plane[1], plane[3], plane[5], plane[7]];
  const top = Math.min(...ys), bottom = Math.max(...ys);
  if (top > horizon + 0.02) return "floor";
  if (bottom < horizon - 0.02) return "ceiling";
  return "wall";
}

// ---------------------------------------------------------------- smooth bands: sky, ceiling, snow, floor

function rowEnergy(gray: Gray): Float32Array {
  const { data, width, height } = gray;
  const out = new Float32Array(height);
  const x0 = Math.floor(width * 0.1), x1 = Math.ceil(width * 0.9);
  for (let y = 1; y < height - 1; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      s += Math.abs(data[i + 1] - data[i - 1]) / 2 + Math.abs(data[i + width] - data[i - width]) / 2;
    }
    out[y] = s / (x1 - x0);
  }
  out[0] = out[1]; out[height - 1] = out[height - 2];
  // A five-row mean, so one branch or one wire does not end a band.
  const smooth = new Float32Array(height);
  for (let y = 0; y < height; y++) { let s = 0, n = 0; for (let k = -2; k <= 2; k++) { const yy = y + k; if (yy >= 0 && yy < height) { s += out[yy]; n++; } } smooth[y] = s / n; }
  return smooth;
}

/** Smooth bands at the top and bottom of the picture: sky (or a plain ceiling) and snow, lawn or a plain floor. */
function bandCandidates(gray: Gray, horizon: number | null, vpx: number): Raw[] {
  const e = rowEnergy(gray), h = gray.height;
  const out: Raw[] = [];
  let top = 0;
  while (top < h && e[top] < 4.5) top++;
  if (top >= 0.1 * h) {
    let sum = 0, n = 0;
    for (let y = 0; y < top; y += 2) for (let x = Math.floor(gray.width * 0.1); x < gray.width * 0.9; x += 4) { sum += gray.data[y * gray.width + x]; n++; }
    const lum = n ? sum / n : 128;
    const bottom = Math.max(0.1, top / h - 0.02);
    // From grey alone, sky and a plain ceiling cannot be told apart (a ridge line is as straight as a cornice), and the placement is the same: a vision label settles it.
    out.push({ kind: "sky", label: "Sky or ceiling", source: "band", plane: [0.03, 0.02, 0.97, 0.02, 0.97, bottom, 0.03, bottom], clear: true, prior: lum > 80 ? 0 : -0.1, note: "a smooth band across the top" });
  }
  let bottomRow = h - 1;
  while (bottomRow >= 0 && e[bottomRow] < 6) bottomRow--;
  const from = bottomRow + 1;
  if (h - from >= 0.14 * h) {
    const farY = Math.min(0.9, from / h + 0.02);
    let plane = [0.0, farY, 1.0, farY, 1.0, 0.97, 0.0, 0.97];
    if (horizon !== null && horizon < farY - 0.04) plane = convergeToHorizon(plane, horizon, vpx) ?? plane;
    out.push({ kind: "ground", label: "Floor or ground", source: "band", plane, clear: true, prior: 0, note: "a smooth band across the bottom" });
  }
  return out;
}

// ---------------------------------------------------------------- the search

type Measured = SurfaceCandidate & { _priority: number };

const KIND_LABEL: Record<SurfaceKind, string> = { wall: "Wall", floor: "Floor", ceiling: "Ceiling", sky: "Sky", tabletop: "Table", ground: "Ground", window: "Window", other: "Surface" };

/** Brings a gray frame to the size the geometry works at (about 180 wide), keeping the original for the tracker-scale texture test. */
function workSize(gray: Gray): Gray {
  let g = gray;
  while (g.width > 220 && g.height > 120) g = downsample(g);
  return g;
}

/**
 * Propose surfaces for a title in one frame. `gray` is the composition frame
 * as the tracker sees it (ADR 0047), ideally the tracker's own size (360×640):
 * texture is judged at that size, the geometry at about half of it. Returns the
 * best few, best first, plus those turned down and why.
 */
export function findSurfaces(gray: Gray, text: SurfaceText, hints: SurfaceHints = {}, options: SurfaceOptions = {}): SurfaceSearch {
  const top = options.top ?? 3;
  const work = workSize(gray);
  const w = work.width, h = work.height;
  const points = edgePoints(work, 0, 0, w, h, gradientThreshold(work));
  const lines = points.length >= 40 ? houghLines(points, w, h, { minVotes: Math.round(Math.min(w, h) * 0.12), max: 48 }) : [];
  const map = buildEdgeMap(points, work);

  const measured = estimateHorizon(lines, w, h);
  const horizon = hints.horizonY !== undefined && hints.horizonY !== null ? clamp(hints.horizonY, -0.5, 1.5) : measured && measured.strength >= 0.4 ? measured.y : null;
  const vpx = measured?.vpx !== null && measured?.vpx !== undefined ? clamp(measured.vpx, 0.1, 0.9) : 0.5;

  // Regions the model named, put on the picture's real edges.
  const raws: Raw[] = [];
  for (const region of hints.regions ?? []) {
    const rough = region.quad.map((v, i) => (i % 2 === 0 ? clamp(v, -0.1, 1.1) * w : clamp(v, -0.1, 1.1) * h)) as Quad;
    const snap = snapQuadToEdges(rough, lines, map);
    let plane = snap.quad.map((v, i) => (i % 2 === 0 ? v / w : v / h));
    if (snap.snapped === 0 && horizon !== null && (region.kind === "floor" || region.kind === "ground" || region.kind === "ceiling" || region.kind === "tabletop")) plane = convergeToHorizon(plane, horizon, vpx) ?? plane;
    raws.push({ kind: region.kind, source: "vision", plane: plane.map(round4), clear: region.clear !== false, prior: 0.04 + 0.06 * clamp(region.confidence, 0, 1), note: region.note, snapped: snap.snapped });
  }
  // Where a model has looked at the picture and named surfaces, edges alone are a second opinion: a roof line and a snow line
  // make a tidy quad that is no wall, and must not outrank the wall the model pointed at.
  const looked = raws.length > 0;
  raws.push(...lineQuads(lines, map, horizon).map((r) => ({ ...r, prior: looked ? -0.12 : 0 })));
  raws.push(...bandCandidates(work, horizon, vpx).map((r) => ({ ...r, prior: r.prior - (looked ? 0.08 : 0) })));

  const tex = gray.width > 400 ? downsample(gray) : gray;
  const level = buildPyramid(tex, 1)[0];
  const rejected: SurfaceSearch["rejected"] = [];
  const all: Measured[] = [];
  raws.forEach((raw, index) => {
    const reject = (reason: string) => rejected.push({ kind: raw.kind, source: raw.source, plane: raw.plane, reason });
    const plane = raw.plane;
    if (!isConvex(plane)) return reject("not a convex four-sided shape");
    const area = frameShare(plane);
    if (area < 0.035) return reject("too small to carry a title");
    if (area > 0.93) return reject("the whole frame, not a surface");
    const planeW = plane.map((v, i) => (i % 2 === 0 ? v * w : v * h)) as Quad;
    const angle = minAngle(toPx(plane));
    if (angle < 22) return reject(`seen too steeply (a ${Math.round(angle)}° corner)`);
    const placed = fitTitleOnPlane(plane, text.aspect);
    if (!placed) return reject("no legible title fits inside it, in the safe area");

    // Texture, as the tracker will measure it on the plane (it takes features from there) and the title's own share of it.
    const planeT = plane.map((v, i) => (i % 2 === 0 ? v * tex.width : v * tex.height)) as Quad;
    const placeT = placed.quad.map((v, i) => (i % 2 === 0 ? v * tex.width : v * tex.height)) as Quad;
    const margin = Math.min(6, Math.sqrt(Math.abs(signedArea(planeT))) * 0.2);
    const features = supportPoints(level, planeT, { margin, maxPoints: 80 });
    const coverage = quadCoverage(features, placeT, tex.width, tex.height).coverage;
    const trackable = features.length >= MIN_POINTS && coverage >= MIN_COVERAGE;

    // Size: a surface worth painting on is a good part of the frame, not nearly all of it.
    const size = clamp(Math.pow(area / 0.3, 0.6), 0, 1) * (area > 0.7 ? 0.7 : 1);
    const textureScore = clamp(features.length / 30, 0, 1) * 0.6 + clamp(coverage / 0.7, 0, 1) * 0.4;
    // Fit: legible line, mild perspective, nothing in front of it, and a shape that takes a title.
    const lineScore = clamp((placed.lineHeightPx - SURFACE_MIN_LINE_PX) / (140 - SURFACE_MIN_LINE_PX), 0, 1);
    const anglesScore = clamp((angle - 22) / 38, 0, 1);
    const { width: pw, height: ph } = surfacePlaneSize(plane);
    const shapeScore = clamp((pw / ph) / 1.2, 0.35, 1);
    const clutter = interiorClutter(planeW, lines, map);
    if (clutter >= 0.6) return reject("an edge runs straight across it: it is two surfaces, not one");
    // Edges alone are a weaker witness than a model that looked at the picture: held to a higher bar.
    if (raw.source === "lines" && (area < 0.08 || clutter >= 0.25)) return reject(area < 0.08 ? "too small to be convincing from edges alone" : "an edge runs across it, and nothing but edges vouches for it");
    const whole = 1 - clamp(clutter * 0.9, 0, 0.6);
    const fit = (0.35 * lineScore + 0.3 * anglesScore + 0.2 * shapeScore + 0.15 * (raw.clear ? 1 : 0)) * whole;
    const total = (0.3 * size + 0.4 * textureScore + 0.3 * fit) * whole + raw.prior;
    const ink = surfaceInk(gray, placed.quad);
    const reasons: string[] = [];
    reasons.push(trackable ? `${features.length} points of detail to follow, spread over ${Math.round(coverage * 100)}% of the title` : features.length < MIN_POINTS ? "almost no detail to follow: it can be placed but not tracked" : "detail is bunched in one part: it can be placed but not tracked");
    reasons.push(`covers ${Math.round(area * 100)}% of the frame`);
    if (!raw.clear) reasons.push("something stands in front of part of it");
    if (clutter > 0.25) reasons.push("an edge runs across it, so it may be two surfaces");
    if (angle < 40) reasons.push("seen at a steep angle, so the title is strongly foreshortened");
    if (raw.note) reasons.push(raw.note);
    all.push({
      id: `${raw.source}-${raw.kind}-${index}`, kind: raw.kind, label: raw.label ?? KIND_LABEL[raw.kind], source: raw.source, plane: plane.map(round4), placement: placed.quad, area: round4(area),
      texture: { points: features.length, coverage: round4(coverage) }, tracking: trackable ? "surface" : "fixed",
      scores: { size: round4(size), texture: round4(textureScore), fit: round4(fit), total: round4(total) }, ink, reasons,
      // Followable surfaces come before fixed ones whatever their score; a fixed one is a fallback.
      _priority: trackable ? 1 : 0,
    });
  });

  // Best first; of two that cover the same ground, the better one only.
  const rank = (c: Measured) => c.scores.total - (c.tracking === "fixed" ? 0.12 : 0);
  all.sort((x, y) => rank(y) - rank(x));
  const deduped: Measured[] = [];
  for (const c of all) {
    const dup = deduped.find((p) => surfaceOverlap(p.plane, c.plane) >= 0.5);
    if (dup) { rejected.push({ kind: c.kind, source: c.source, plane: c.plane, reason: `overlaps a better ${dup.label.toLowerCase()}` }); continue; }
    if (c.tracking === "fixed" && options.keepFixed === false) { rejected.push({ kind: c.kind, source: c.source, plane: c.plane, reason: "cannot be tracked" }); continue; }
    deduped.push(c);
  }
  // The first two are the best two. The third is the best of a kind not yet shown, if it is any good (a sky beside two walls),
  // otherwise the next best: three of a kind is a worse menu than a variety.
  const picked: Measured[] = deduped.slice(0, Math.min(top, 2));
  const rest = deduped.slice(picked.length);
  while (picked.length < top && rest.length) {
    const fresh = rest.findIndex((c) => !picked.some((p) => p.kind === c.kind) && c.scores.total >= 0.4);
    picked.push(...rest.splice(fresh >= 0 ? fresh : 0, 1));
  }
  // A label that names its place when two are the same kind ("Wall, left" / "Wall, right").
  const result = picked.map(({ _priority, ...c }) => { void _priority; return c; });
  for (const c of result) {
    const same = result.filter((o) => o.kind === c.kind);
    if (same.length > 1) {
      const cx = (c.plane[0] + c.plane[2] + c.plane[4] + c.plane[6]) / 4, cy = (c.plane[1] + c.plane[3] + c.plane[5] + c.plane[7]) / 4;
      c.label = `${c.label}, ${cx < 0.4 ? "left" : cx > 0.6 ? "right" : cy < 0.4 ? "upper" : cy > 0.6 ? "lower" : "centre"}`;
    }
  }
  return { candidates: result, rejected, horizonY: horizon === null ? null : round4(horizon), lines: lines.length };
}

/** The candidate whose kind matches a pick ("auto" is the first); null when none does. */
export function pickCandidate(candidates: readonly SurfaceCandidate[], pick: "wall" | "floor" | "ceiling" | "sky" | "tabletop" | "ground" | "window" | "auto" = "auto"): SurfaceCandidate | null {
  if (pick === "auto") return candidates[0] ?? null;
  const aliases: Record<string, SurfaceKind[]> = { floor: ["floor", "ground", "tabletop"], ground: ["ground", "floor"], wall: ["wall", "window"], sky: ["sky", "ceiling"], ceiling: ["ceiling", "sky"], tabletop: ["tabletop", "floor"], window: ["window", "wall"] };
  const wanted = aliases[pick] ?? [pick];
  return candidates.find((c) => wanted.includes(c.kind)) ?? null;
}
