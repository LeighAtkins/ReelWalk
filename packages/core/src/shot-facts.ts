/**
 * What the cut planner (ADR 0087) reads from a clip's shot analysis (ADR 0086, `shot-analysis.ts`, built in parallel
 * on feat/shot-analysis). Typed structurally, as the subset of `ShotAnalysis` the planner uses, so a stored analysis
 * passes straight in and this branch compiles without that file; the few helpers below mirror the contract's own
 * (`flowDirection`, `meanFlow`, `sampleAt`, `toReelPoint`, `eyeTraceDistance`) and give the same numbers.
 *
 * Conventions are the contract's: source ms; points are source-frame fractions; flow is CONTENT motion (dx > 0 moves
 * right), named the way the eye follows it.
 */

/** Content motion as the eye follows it; "rotate" is a turn (a drone orbit), ADR 0086's second version. */
export type FlowDirection = "left" | "right" | "up" | "down" | "push" | "pull" | "rotate" | "static";
export type FacetPoint = { x: number; y: number };
export type FacetBox = { x: number; y: number; w: number; h: number };

export type PlannerSample = {
  t: number;
  sharpness: number;
  steady: number;
  luma: number;
  /** dx and dy both in frame widths a second; `rotate` rad/s (optional); `residual` is localised unexplained change. */
  flow: { dx: number; dy: number; zoom: number; magnitude: number; residual: number; rotate?: number };
  saliency: FacetPoint & { strength: number };
};

export type PlannerWindow = { startMs: number; endMs: number; score: number; motion: number; direction: FlowDirection };

export type PlannerAnalysis = {
  durationMs: number;
  width: number;
  height: number;
  samples: PlannerSample[];
  windows: { lengthMs: number; best: PlannerWindow[] }[];
  motion: { startMs: number; endMs: number; direction: FlowDirection; magnitude: number; mover: string; consistency: number }[];
  flowPeaks: { t: number; magnitude: number; direction: FlowDirection; mover: string }[];
  depth: { t: number; cols: number; rows: number; grid: string; foreground: number; near: FacetBox | null; spread: number }[];
  occluders: { startMs: number; endMs: number; peakMs: number; direction: "left" | "right" | "up" | "down"; coverage: number; edgeFrom: number; edgeTo: number; near: boolean; score: number }[];
  reframe: { aspect: number; cropWidth: number; path: { t: number; x: number; y: number }[]; closeUps: { startMs: number; endMs: number; box: FacetBox; sourcePx: number; score: number }[] } | null;
  scene: {
    palette: { hex: string; share: number }[];
    round: { t: number; x: number; y: number; r: number; score: number } | null;
    brightnessRamps: { startMs: number; endMs: number; from: number; to: number; kind: "up" | "down" }[];
    blowouts: { t: number; box: FacetBox; share: number; kind: "sky" | "window" }[];
  };
};

/** Below this edge speed (frame widths a second) a window reads as static (the contract's STATIC_FW_PER_S, 0.01 since its second version). */
export const STATIC_FW_PER_S = 0.01;
const REEL_ASPECT = 9 / 16;

export function flowDirection(flow: { dx: number; dy: number; zoom: number; rotate?: number }, still = STATIC_FW_PER_S): FlowDirection {
  const slide = Math.hypot(flow.dx, flow.dy), zoomEdge = Math.abs(flow.zoom) * 0.5, turn = Math.abs(flow.rotate ?? 0) * 0.5;
  if (Math.max(slide, zoomEdge, turn) < still) return "static";
  if (turn > slide && turn > zoomEdge) return "rotate";
  if (zoomEdge >= slide / 1.33) return flow.zoom > 0 ? "push" : "pull";
  if (Math.abs(flow.dx) >= Math.abs(flow.dy)) return flow.dx > 0 ? "right" : "left";
  return flow.dy > 0 ? "down" : "up";
}

/**
 * How much larger motion looks in the reel than in the source: a landscape source shown as a 9:16 cover crop is seen
 * through a crop a third of its width wide, so a slow glide of 0.015 source widths a second crosses 5 % of the reel's
 * frame a second. The planner judges "still" in the reel's frame.
 */
export function reelMotionScale(analysis: Pick<PlannerAnalysis, "width" | "height">): number {
  const aspect = analysis.width / analysis.height;
  return aspect > REEL_ASPECT ? aspect / REEL_ASPECT : 1;
}

/** Mean content flow over [startMs, endMs) and its direction and edge speed; static with no samples. */
export function meanFlow(samples: readonly PlannerSample[], startMs: number, endMs: number, still = STATIC_FW_PER_S): { dx: number; dy: number; zoom: number; direction: FlowDirection; magnitude: number } {
  const inside = samples.filter((s) => s.t >= startMs && s.t < endMs);
  if (!inside.length) return { dx: 0, dy: 0, zoom: 0, direction: "static", magnitude: 0 };
  const mean = (pick: (s: PlannerSample) => number) => inside.reduce((sum, s) => sum + pick(s), 0) / inside.length;
  const dx = mean((s) => s.flow.dx), dy = mean((s) => s.flow.dy), zoom = mean((s) => s.flow.zoom), rotate = mean((s) => s.flow.rotate ?? 0);
  return { dx, dy, zoom, direction: flowDirection({ dx, dy, zoom, rotate }, still), magnitude: Math.max(Math.hypot(dx, dy), Math.abs(zoom) * 0.5, Math.abs(rotate) * 0.5) };
}

export function sampleAt(samples: readonly PlannerSample[], t: number): PlannerSample | null {
  let best: PlannerSample | null = null;
  for (const s of samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
}

/** The reframe crop's centre at `t` (linear between keys, kept inside the frame); centred without a path. */
export function cropCentreAt(path: readonly { t: number; x: number; y: number }[], t: number, cropWidth = 1): FacetPoint {
  const half = cropWidth / 2;
  const keep = (x: number) => Math.min(1 - half, Math.max(half, x));
  if (!path.length) return { x: 0.5, y: 0.5 };
  if (t <= path[0].t) return { x: keep(path[0].x), y: path[0].y };
  const last = path[path.length - 1];
  if (t >= last.t) return { x: keep(last.x), y: last.y };
  let i = 1;
  while (path[i].t < t) i++;
  const a = path[i - 1], b = path[i];
  const f = (t - a.t) / Math.max(1, b.t - a.t);
  return { x: keep(a.x + (b.x - a.x) * f), y: a.y + (b.y - a.y) * f };
}

/** A source point as a point of the 9:16 reel frame, through the reframe crop when there is one, else a centred cover crop. */
export function toReelPoint(analysis: Pick<PlannerAnalysis, "width" | "height" | "reframe">, p: FacetPoint, t: number): FacetPoint {
  const aspect = analysis.width / analysis.height;
  if (aspect > REEL_ASPECT) {
    const w = REEL_ASPECT / aspect;
    const centre = analysis.reframe ? cropCentreAt(analysis.reframe.path, t, w).x : 0.5;
    const left = Math.min(1 - w, Math.max(0, centre - w / 2));
    return { x: (p.x - left) / w, y: p.y };
  }
  const h = aspect / REEL_ASPECT;
  return { x: p.x, y: (p.y - (1 - h) / 2) / h };
}

/** Distance between two reel-frame points in reel-frame widths (a frame height is 16/9 widths). */
export function eyeTraceDistance(a: FacetPoint, b: FacetPoint): number {
  return Math.hypot(a.x - b.x, (a.y - b.y) / REEL_ASPECT);
}

/** Where the eye is at source time `t`, in reel-frame fractions; null without samples. */
export function attentionAt(analysis: PlannerAnalysis, t: number): FacetPoint | null {
  const s = sampleAt(analysis.samples, t);
  return s ? toReelPoint(analysis, s.saliency, t) : null;
}

/** Whether two directions carry across a cut. */
export const directionsAgree = (a: FlowDirection, b: FlowDirection) => a === b && a !== "static";

/** The best windows of the stored length nearest `lengthMs`. */
export function windowsNear(analysis: PlannerAnalysis, lengthMs: number): PlannerWindow[] {
  const sets = [...analysis.windows].filter((set) => set.best.length).sort((a, b) => Math.abs(a.lengthMs - lengthMs) - Math.abs(b.lengthMs - lengthMs));
  return sets[0]?.best ?? [];
}

/** The quality of [startMs, endMs) from the samples: sharpness and steadiness, 0..1 (0.5 with no samples). */
export function spanQuality(analysis: PlannerAnalysis, startMs: number, endMs: number): number {
  const inside = analysis.samples.filter((s) => s.t >= startMs && s.t < endMs);
  if (!inside.length) return 0.5;
  return inside.reduce((sum, s) => sum + 0.6 * s.sharpness + 0.4 * s.steady, 0) / inside.length;
}

/** The mean flow of a span with "still" judged as the reel shows it (see `reelMotionScale`). */
export function reelFlow(analysis: PlannerAnalysis, startMs: number, endMs: number) {
  return meanFlow(analysis.samples, startMs, endMs, STATIC_FW_PER_S / reelMotionScale(analysis));
}
