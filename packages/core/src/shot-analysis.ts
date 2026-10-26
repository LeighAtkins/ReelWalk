/**
 * What is in the picture, per clip and per moment (ADR 0086): the facts the cut
 * planner and the director choose in-points, out-points and transitions by.
 *
 * The worker measures every video once, when its 720p proxy lands, sampling
 * every `sampleMs` of source time, and stores one `ShotAnalysis` on the media
 * asset (`MediaAsset.shotAnalysis`). This file is the contract: the schema,
 * plus the pure functions every reader shares (window choice, flow direction,
 * eye-trace distance, the summary the director sees).
 *
 * Conventions, everywhere in the contract:
 * - Times are SOURCE milliseconds of the asset (not reel time), integers.
 * - Points and boxes are fractions of the SOURCE frame, 0..1, x right, y down,
 *   unless a name says `reel` (then they are fractions of the 9:16 reel frame,
 *   after the reframe crop).
 * - Scores are 0..1, higher is better (or more), unless documented otherwise.
 * - Flow is content motion: dx > 0 means the picture content moves right on
 *   screen, which is the camera panning LEFT. `direction` names the CONTENT
 *   motion too ("left" = things slide to the left = camera pans right), the
 *   way a viewer's eye follows it across a cut.
 *
 * Additive only: a reader must accept a missing optional field. `version`
 * changes only on a breaking change, which the ADR says must not happen.
 */
import { z } from "zod";

export const SHOT_ANALYSIS_VERSION = 1 as const;
/** Default spacing of samples, ms of source time. */
export const SHOT_SAMPLE_MS = 250;
/** The window lengths the planner asks for, ms. */
export const WINDOW_LENGTHS_MS = [800, 1500, 2500, 4000] as const;
export type WindowLengthMs = (typeof WINDOW_LENGTHS_MS)[number];

/**
 * Content motion, named the way the eye follows it. push = the picture expands (dolly or zoom in), pull = it shrinks,
 * rotate = the picture turns about a point (a roll, or a drone orbit that the frame-wide fit reads as one).
 */
export const FLOW_DIRECTIONS = ["left", "right", "up", "down", "push", "pull", "rotate", "static"] as const;
export const flowDirectionSchema = z.enum(FLOW_DIRECTIONS);
export type FlowDirection = z.infer<typeof flowDirectionSchema>;

/** Who moves: the camera (the whole picture agrees on one flow), a subject (part of it moves against a still frame), both, or neither. */
export const MOVERS = ["camera", "subject", "both", "none"] as const;
export const moverSchema = z.enum(MOVERS);
export type Mover = z.infer<typeof moverSchema>;

const unit = z.number().min(0).max(1);
const ms = z.number().int().min(0);
/** A point in frame fractions; a little outside 0..1 is allowed for things leaving the frame. */
const point = z.object({ x: z.number().min(-0.5).max(1.5), y: z.number().min(-0.5).max(1.5) });
export type FramePoint = z.infer<typeof point>;
const box = z.object({ x: unit, y: unit, w: unit, h: unit });
export type FrameBox = z.infer<typeof box>;

/** Global flow at one sample, from an affine fit over the frames either side of it. Rates per second. */
export const sampleFlowSchema = z.object({
  /** Content velocity, both in frame WIDTHS a second so speeds compare: dx > 0 moves right, dy > 0 moves down. */
  dx: z.number(),
  dy: z.number(),
  /** Scale growth a second: > 0 push, < 0 pull. */
  zoom: z.number(),
  /** Turn in radians a second, > 0 clockwise. Absent reads as 0. */
  rotate: z.number().optional(),
  /** Edge speed of the dominant motion, frame widths a second (>= 0): pan speed, or half the zoom or turn rate. */
  magnitude: z.number().min(0),
  /**
   * Localised change the global flow does NOT explain, 0..1: high when one part of the picture moves on its own (a
   * person, a door, a car) against the rest; low for a still frame and for parallax spread over the whole picture.
   */
  residual: unit,
});
export type SampleFlow = z.infer<typeof sampleFlowSchema>;

/** One sample of a clip: everything measured at source time `t`. */
export const shotSampleSchema = z.object({
  t: ms,
  /** Variance of the Laplacian of the 480 px grey frame, normalised: 0 mush, 1 crisp (raw / (raw + 120)). */
  sharpness: unit,
  /** Share of pixels crushed to black (< 4/255) and blown to white (> 251/255). */
  clipLow: unit,
  clipHigh: unit,
  /** Mean luma 0..1. */
  luma: unit,
  /** Aesthetic score 0..1 (CLIP-IQA prompt pairs on MobileCLIP-S0), measured every `aestheticEveryMs`; absent between. */
  aesthetic: unit.optional(),
  /** How steady the camera is: 1 locked or smooth glide, 0 handheld shake (high-frequency flow jitter). */
  steady: unit,
  flow: sampleFlowSchema,
  /** Where the eye goes: the spectral-residual saliency peak, with its strength (peak over mean, squashed to 0..1). */
  saliency: point.extend({ strength: unit }),
});
export type ShotSample = z.infer<typeof shotSampleSchema>;

/** A scored window of a clip: a candidate in/out point pair for a shot of `lengthMs`. */
export const shotWindowSchema = z.object({
  startMs: ms,
  endMs: ms,
  /** Overall 0..1: the weighted mean of the parts below, with any badly soft or blown sample pulling it down. */
  score: unit,
  sharpness: unit,
  exposure: unit,
  aesthetic: unit,
  steady: unit,
  /** How much motion the window has, 0 still .. 1 brisk (the rule: motion never stops, but not a whip). */
  motion: unit,
  direction: flowDirectionSchema,
});
export type ShotWindow = z.infer<typeof shotWindowSchema>;

/** The best few non-overlapping windows of one length, best first. */
export const windowSetSchema = z.object({ lengthMs: z.number().int().positive(), best: z.array(shotWindowSchema).max(5) });
export type WindowSet = z.infer<typeof windowSetSchema>;

/** A run of samples with one motion: what a match-on-direction cut joins. */
export const motionSegmentSchema = z.object({
  startMs: ms,
  endMs: ms,
  direction: flowDirectionSchema,
  /** Mean edge speed, frame widths a second. */
  magnitude: z.number().min(0),
  mover: moverSchema,
  /** How consistent the direction is inside the segment, 0..1. */
  consistency: unit,
});
export type MotionSegment = z.infer<typeof motionSegmentSchema>;

/** A local maximum of motion: a cut-on-action point (a turn, a step through, a person rising). */
export const flowPeakSchema = z.object({ t: ms, magnitude: z.number().min(0), direction: flowDirectionSchema, mover: moverSchema });
export type FlowPeak = z.infer<typeof flowPeakSchema>;

/**
 * A monocular depth reading at one sample (Depth Anything V2 small). `grid` is a
 * `cols` × `rows` map, row-major, of relative nearness 0 (far) .. 255 (near),
 * base64 of the bytes: enough for a rack-focus blur mask and to see a near
 * object, small enough to store.
 */
export const depthSampleSchema = z.object({
  t: ms,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  grid: z.string(),
  /** Share of the frame that is clearly foreground (nearness > 0.66 of the frame's range). */
  foreground: unit,
  /** The nearest blob's box, if a compact near object stands apart from the rest (a pillar, a door frame, a chair). */
  near: box.nullable(),
  /** Depth spread 0..1: a deep corridor or a view is high, a flat wall low. Rack focus needs it. */
  spread: unit,
});
export type DepthSample = z.infer<typeof depthSampleSchema>;

/**
 * A dark or near object sweeping across the lens: a door frame, wall edge, pillar or person. The planner hides a cut
 * inside it (an occlusion wipe): cut at `peakMs` when the frame is most covered, or mask-wipe along its leading edge.
 */
export const occluderSchema = z.object({
  startMs: ms,
  endMs: ms,
  /** When the most of the frame is covered. */
  peakMs: ms,
  /** The way the occluder travels across the frame (content motion). */
  direction: z.enum(["left", "right", "up", "down"]),
  /** Most of the frame width it covers at the peak, 0..1. */
  coverage: unit,
  /** Position (frame fraction, along `direction`) at start and end of the band's edge that moves most: an entering post's leading edge, a leaving wall's inner edge. A wipe follows it. */
  edgeFrom: z.number().min(-0.5).max(1.5),
  edgeTo: z.number().min(-0.5).max(1.5),
  /** Read as near (parallax faster than the background, or confirmed by a depth sample) rather than merely dark. */
  near: z.boolean(),
  /** How sure, 0..1. */
  score: unit,
});
export type Occluder = z.infer<typeof occluderSchema>;

/** One keyframe of the reframe: where the 9:16 crop is centred on the source at source time `t`. */
export const cropKeySchema = z.object({ t: ms, x: unit, y: unit });
export type CropKey = z.infer<typeof cropKeySchema>;

/** A region with enough real pixels for a detail shot cropped out of the source (a virtual close-up). */
export const closeUpSchema = z.object({
  startMs: ms,
  endMs: ms,
  /** The 9:16 crop box, source fractions. */
  box,
  /** Width of the box in real source pixels (>= 720 to qualify). */
  sourcePx: z.number().int().min(0),
  /** Why it is worth a cut: sharp, salient, steady, and not just a blank wall. */
  score: unit,
});
export type CloseUp = z.infer<typeof closeUpSchema>;

/**
 * The reframe: for a source wider than 9:16, a smooth, subject-following 9:16 crop (`path`); for any source with enough
 * real pixels, virtual close-ups. `path` is empty for a portrait source; the whole field is null when there is neither.
 */
export const reframeSchema = z.object({
  /** Source width / height (from the original, not the proxy). */
  aspect: z.number().positive(),
  /** Width of the 9:16 crop as a fraction of the source width. */
  cropWidth: unit,
  /** Keyframes, every 500 ms, already smoothed (critically damped, dead-banded, speed-limited): render them as they are. `y` is 0.5 (the crop is full height). */
  path: z.array(cropKeySchema).max(600),
  closeUps: z.array(closeUpSchema).max(12),
});
export type Reframe = z.infer<typeof reframeSchema>;

/** Scene facts for shape, colour and light match cuts. */
export const sceneFactsSchema = z.object({
  /** Dominant colours over the clip, by share of pixels, most first. */
  palette: z.array(z.object({ hex: z.string().regex(/^#[0-9a-f]{6}$/), share: unit })).max(6),
  /** The strongest round shape (a pendant, a mirror, a bowl) and when it is clearest; null if nothing round stands out. */
  round: z.object({ t: ms, x: unit, y: unit, r: unit, score: unit }).nullable(),
  /** How rectilinear the picture is (doors, windows, cabinetry): share of edge energy within 10° of horizontal or vertical. */
  rectilinear: unit,
  /** Lights switching on, a sun flare, curtains opening (up), or the reverse (down): a luma change inside 2 s. */
  brightnessRamps: z.array(z.object({ startMs: ms, endMs: ms, from: unit, to: unit, kind: z.enum(["up", "down"]) })).max(8),
  /** Blown-out regions (a window, the sky), when they are there, with how much of the frame they take. */
  blowouts: z.array(z.object({ t: ms, box, share: unit, kind: z.enum(["sky", "window"]) })).max(8),
});
export type SceneFacts = z.infer<typeof sceneFactsSchema>;

export const shotAnalysisSchema = z.object({
  version: z.literal(SHOT_ANALYSIS_VERSION),
  /** Source duration and size (the original upload's, as recorded on the asset). */
  durationMs: ms,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sampleMs: z.number().int().positive(),
  /** Spacing of the aesthetic samples (they cost the most), ms. */
  aestheticEveryMs: z.number().int().positive(),
  samples: z.array(shotSampleSchema).max(2400),
  windows: z.array(windowSetSchema),
  motion: z.array(motionSegmentSchema),
  flowPeaks: z.array(flowPeakSchema).max(40),
  depth: z.array(depthSampleSchema).max(16),
  occluders: z.array(occluderSchema).max(16),
  reframe: reframeSchema.nullable(),
  scene: sceneFactsSchema,
  /** Which models made the numbers, so a reader can tell an old analysis from a new one. */
  models: z.object({ aesthetic: z.string().nullable(), depth: z.string().nullable(), saliency: z.string() }),
  /** What it cost: CPU ms (user + system) and wall ms of the whole analysis, and the source ms it covered. */
  cost: z.object({ cpuMs: z.number().int().min(0), wallMs: z.number().int().min(0), analysedMs: ms }).optional(),
  createdAt: z.string().optional(),
});
export type ShotAnalysis = z.infer<typeof shotAnalysisSchema>;

/** Reads a stored analysis, or null when it is absent or not this version (re-run it rather than guess). */
export function parseShotAnalysis(value: unknown): ShotAnalysis | null {
  const parsed = shotAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Flow direction
// ---------------------------------------------------------------------------

/** Below this edge speed (frame widths a second) a window reads as static: a 2 %/s push (gimbal footage) still counts as motion. */
export const STATIC_FW_PER_S = 0.01;
/** A push or pull wins over a slide when its edge speed is at least this share of the slide's (the bias of motion-kind.ts). */
const ZOOM_LEAD = 1 / 1.33;

/** The direction of content motion `flow` (rates per second), as the eye reads it. */
export function flowDirection(flow: Pick<SampleFlow, "dx" | "dy" | "zoom" | "rotate">, still = STATIC_FW_PER_S): FlowDirection {
  const slide = Math.hypot(flow.dx, flow.dy), zoomEdge = Math.abs(flow.zoom) * 0.5, turnEdge = Math.abs(flow.rotate ?? 0) * 0.5;
  if (Math.max(slide, zoomEdge, turnEdge) < still) return "static";
  // A turn must lead plainly and be well clear of still: a frame-wide fit finds a little roll in any slow drift.
  if (turnEdge >= 2 * still && turnEdge >= slide * 2 && turnEdge >= zoomEdge * 2) return "rotate";
  if (Math.max(slide, zoomEdge) < still) return "static";
  if (zoomEdge >= slide * ZOOM_LEAD) return flow.zoom > 0 ? "push" : "pull";
  if (Math.abs(flow.dx) >= Math.abs(flow.dy)) return flow.dx > 0 ? "right" : "left";
  return flow.dy > 0 ? "down" : "up";
}

/** Edge speed of a flow, frame widths a second. */
export function flowMagnitude(flow: Pick<SampleFlow, "dx" | "dy" | "zoom" | "rotate">): number {
  return Math.max(Math.hypot(flow.dx, flow.dy), Math.abs(flow.zoom) * 0.5, Math.abs(flow.rotate ?? 0) * 0.5);
}

/** Who moves, from how fast the whole frame moves (and, when known, whether its direction reads as static) and how much change it leaves unexplained. */
export function moverOf(magnitude: number, residual: number, direction?: FlowDirection): Mover {
  const camera = magnitude >= STATIC_FW_PER_S && direction !== "static", subject = residual >= 0.3;
  return camera && subject ? "both" : camera ? "camera" : subject ? "subject" : "none";
}

/** The mean flow over the samples in [startMs, endMs), and its direction. */
export function meanFlow(samples: readonly ShotSample[], startMs: number, endMs: number): { dx: number; dy: number; zoom: number; rotate: number; residual: number; direction: FlowDirection; magnitude: number } {
  const inside = samples.filter((s) => s.t >= startMs && s.t < endMs);
  const n = Math.max(1, inside.length);
  const dx = inside.reduce((sum, s) => sum + s.flow.dx, 0) / n;
  const dy = inside.reduce((sum, s) => sum + s.flow.dy, 0) / n;
  const zoom = inside.reduce((sum, s) => sum + s.flow.zoom, 0) / n;
  const rotate = inside.reduce((sum, s) => sum + (s.flow.rotate ?? 0), 0) / n;
  const residual = inside.reduce((sum, s) => sum + s.flow.residual, 0) / n;
  return { dx, dy, zoom, rotate, residual, direction: flowDirection({ dx, dy, zoom, rotate }), magnitude: flowMagnitude({ dx, dy, zoom, rotate }) };
}

/** Whether two directions carry across a cut: the same way, or both static (a held frame into a held frame is not a carry). */
export function directionsAgree(a: FlowDirection, b: FlowDirection): boolean {
  return a === b && a !== "static";
}

// ---------------------------------------------------------------------------
// Best windows
// ---------------------------------------------------------------------------

/** Edge speed that counts as full motion for scoring (a steady walk or pan); faster stops adding. */
const BRISK_FW_PER_S = 0.12;
/** Above this a window is a whip, not a shot: motion starts to count against it. */
const WHIP_FW_PER_S = 0.6;
/** The first and last 300 ms of a phone clip are the start/stop wobble: a window may not include them. */
export const EDGE_GUARD_MS = 300;

export const WINDOW_WEIGHTS = { sharpness: 0.28, exposure: 0.14, aesthetic: 0.22, steady: 0.16, motion: 0.2 } as const;

/** 0..1 credit for motion: none when still, full when brisk, falling off past a whip. */
export function motionCredit(magnitude: number): number {
  if (magnitude <= STATIC_FW_PER_S) return 0;
  if (magnitude <= BRISK_FW_PER_S) return (magnitude - STATIC_FW_PER_S) / (BRISK_FW_PER_S - STATIC_FW_PER_S);
  if (magnitude <= WHIP_FW_PER_S) return 1;
  return Math.max(0, 1 - (magnitude - WHIP_FW_PER_S) / WHIP_FW_PER_S);
}

/** Exposure credit of one sample: 1 with nothing clipped, 0 with a fifth of the frame blown or crushed. */
export function exposureCredit(sample: Pick<ShotSample, "clipLow" | "clipHigh" | "luma">): number {
  const clipped = Math.min(1, (sample.clipLow + sample.clipHigh) / 0.2);
  // A very dark or very bright mean is poor even before it clips.
  const level = sample.luma < 0.12 ? sample.luma / 0.12 : sample.luma > 0.88 ? (1 - sample.luma) / 0.12 : 1;
  return Math.max(0, Math.min(1, (1 - clipped) * level));
}

/** The aesthetic value at `t`: the nearest measured one, else 0.5 (unknown). */
function aestheticAt(samples: readonly ShotSample[], t: number): number {
  let best: ShotSample | null = null;
  for (const s of samples) if (s.aesthetic !== undefined && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s;
  return best?.aesthetic ?? 0.5;
}

/** Scores the window [startMs, endMs) of `samples`; null when no sample falls inside it. */
export function scoreWindow(samples: readonly ShotSample[], startMs: number, endMs: number): ShotWindow | null {
  const inside = samples.filter((s) => s.t >= startMs && s.t < endMs);
  if (!inside.length) return null;
  const mean = (pick: (s: ShotSample) => number) => inside.reduce((sum, s) => sum + pick(s), 0) / inside.length;
  const sharpness = mean((s) => s.sharpness);
  const exposure = mean(exposureCredit);
  const aesthetic = mean((s) => s.aesthetic ?? aestheticAt(samples, s.t));
  const steady = mean((s) => s.steady);
  const flow = meanFlow(samples, startMs, endMs);
  const motion = motionCredit(mean((s) => s.flow.magnitude));
  const w = WINDOW_WEIGHTS;
  let score = w.sharpness * sharpness + w.exposure * exposure + w.aesthetic * aesthetic + w.steady * steady + w.motion * motion;
  // One badly soft or blown moment spoils the shot: the worst sample pulls the score down.
  const worst = Math.min(...inside.map((s) => Math.min(s.sharpness * 2.5, exposureCredit(s) * 2, 1)));
  score *= 0.6 + 0.4 * worst;
  // A direction change inside a short shot reads as a wobble.
  const consistent = directionConsistency(inside);
  score *= 0.85 + 0.15 * consistent;
  return { startMs, endMs, score: round3(clamp01(score)), sharpness: round3(sharpness), exposure: round3(exposure), aesthetic: round3(aesthetic), steady: round3(steady), motion: round3(motion), direction: flow.direction };
}

/** How many samples agree with the commonest direction, 0..1 (1 for a single sample). */
function directionConsistency(samples: readonly ShotSample[]): number {
  if (samples.length < 2) return 1;
  const counts = new Map<FlowDirection, number>();
  for (const s of samples) counts.set(flowDirection(s.flow), (counts.get(flowDirection(s.flow)) ?? 0) + 1);
  return Math.max(...counts.values()) / samples.length;
}

/**
 * The best `count` non-overlapping windows of `lengthMs`, best first: every start on the sample grid is scored, the
 * edge wobble excluded, then picked greedily. A clip shorter than the window (plus guards) gives one window of what
 * it has, so the planner always has a choice. This replaces "take the middle".
 */
export function bestWindows(samples: readonly ShotSample[], durationMs: number, lengthMs: number, { count = 3, stepMs, guardMs = EDGE_GUARD_MS }: { count?: number; stepMs?: number; guardMs?: number } = {}): ShotWindow[] {
  if (!samples.length || durationMs <= 0) return [];
  const step = stepMs ?? Math.max(1, samples.length > 1 ? samples[1].t - samples[0].t : SHOT_SAMPLE_MS);
  const guard = durationMs >= lengthMs + 2 * guardMs ? guardMs : Math.max(0, (durationMs - lengthMs) / 2);
  // Starts on the sample grid, so a window begins on a measured frame.
  const first = Math.ceil(guard / step - 1e-9) * step, last = durationMs - guard - lengthMs;
  if (last < first) {
    const whole = scoreWindow(samples, 0, durationMs);
    return whole ? [{ ...whole, startMs: 0, endMs: Math.round(durationMs) }] : [];
  }
  const scored: ShotWindow[] = [];
  for (let start = first; start <= last + 1e-6; start += step) {
    const s = Math.round(start);
    const window = scoreWindow(samples, s, s + lengthMs);
    if (window) scored.push(window);
  }
  if (scored.length && scored[scored.length - 1].startMs < Math.round(last)) {
    const window = scoreWindow(samples, Math.round(last), Math.round(last) + lengthMs);
    if (window) scored.push(window);
  }
  scored.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const picked: ShotWindow[] = [];
  for (const window of scored) {
    if (picked.length >= count) break;
    if (picked.every((p) => window.endMs <= p.startMs || window.startMs >= p.endMs)) picked.push(window);
  }
  return picked;
}

/** The window sets for every planner length. */
export function windowSets(samples: readonly ShotSample[], durationMs: number, lengths: readonly number[] = WINDOW_LENGTHS_MS): WindowSet[] {
  return lengths.map((lengthMs) => ({ lengthMs, best: bestWindows(samples, durationMs, lengthMs) }));
}

// ---------------------------------------------------------------------------
// Motion segments and peaks
// ---------------------------------------------------------------------------

/** Runs of one direction, merged across one-sample blips, at least `minMs` long. */
export function motionSegments(samples: readonly ShotSample[], minMs = 500, durationMs = Infinity): MotionSegment[] {
  if (!samples.length) return [];
  const step = samples.length > 1 ? samples[1].t - samples[0].t : SHOT_SAMPLE_MS;
  const dirs = samples.map((s) => flowDirection(s.flow));
  // A lone sample between two of the same direction takes theirs.
  for (let i = 1; i < dirs.length - 1; i++) if (dirs[i - 1] === dirs[i + 1] && dirs[i] !== dirs[i - 1]) dirs[i] = dirs[i - 1];
  const runs: { from: number; to: number; direction: FlowDirection }[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.direction === dirs[i]) last.to = i;
    else runs.push({ from: i, to: i, direction: dirs[i] });
  }
  // Short runs fold into the longer neighbour.
  const long = (run: { from: number; to: number }) => (run.to - run.from + 1) * step >= minMs;
  for (let changed = true; changed && runs.length > 1;) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      if (long(runs[i])) continue;
      const left = runs[i - 1], right = runs[i + 1];
      const into = !left ? right : !right ? left : right.to - right.from >= left.to - left.from ? right : left;
      if (into === left) left.to = runs[i].to;
      else right.from = runs[i].from;
      runs.splice(i, 1);
      changed = true;
      break;
    }
    // Neighbours that now agree merge.
    for (let i = 1; i < runs.length; i++) if (runs[i].direction === runs[i - 1].direction) { runs[i - 1].to = runs[i].to; runs.splice(i, 1); i--; changed = true; }
  }
  return runs.map((run) => {
    const inside = samples.slice(run.from, run.to + 1);
    const startMs = inside[0].t, endMs = Math.round(Math.min(durationMs, inside[inside.length - 1].t + step));
    const flow = meanFlow(inside, startMs, endMs);
    const agree = inside.filter((s) => flowDirection(s.flow) === run.direction).length / inside.length;
    return { startMs, endMs, direction: run.direction, magnitude: round4(flow.magnitude), mover: moverOf(flow.magnitude, flow.residual, run.direction), consistency: round3(agree) };
  });
}

/**
 * Cut-on-action points: local maxima of motion (camera edge speed plus subject residual) that stand clear of their
 * surroundings, at least `gapMs` apart, strongest first, then in time order.
 */
export function flowPeaks(samples: readonly ShotSample[], { gapMs = 700, max = 12 }: { gapMs?: number; max?: number } = {}): FlowPeak[] {
  const energy = samples.map((s) => s.flow.magnitude + 0.25 * s.flow.residual);
  const sorted = [...energy].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const candidates: { i: number; e: number }[] = [];
  for (let i = 1; i < energy.length - 1; i++) {
    if (energy[i] >= energy[i - 1] && energy[i] > energy[i + 1] && energy[i] > Math.max(median * 1.5, 0.06)) candidates.push({ i, e: energy[i] });
  }
  candidates.sort((a, b) => b.e - a.e);
  const picked: { i: number; e: number }[] = [];
  for (const c of candidates) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(samples[p.i].t - samples[c.i].t) >= gapMs)) picked.push(c);
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map(({ i }) => {
      const s = samples[i];
      const direction = flowDirection(s.flow);
      return { t: s.t, magnitude: round4(s.flow.magnitude), direction, mover: moverOf(s.flow.magnitude, s.flow.residual, direction) };
    });
}

// ---------------------------------------------------------------------------
// Eye trace
// ---------------------------------------------------------------------------

/** The cut grammar's eye-trace limit: attention points within 15 % of the reel frame's width. */
export const EYE_TRACE_LIMIT = 0.15;
/** The reel frame, width / height. */
const REEL_ASPECT = 9 / 16;

/** The sample nearest `t`, or null for an empty list. */
export function sampleAt(samples: readonly ShotSample[], t: number): ShotSample | null {
  let lo = 0, hi = samples.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const after = samples[lo], before = samples[Math.max(0, lo - 1)];
  return Math.abs(before.t - t) <= Math.abs(after.t - t) ? before : after;
}

/**
 * A source point as a point of the 9:16 reel frame: through the reframe crop at `t` when the analysis has one, else
 * through a centred cover crop of the source. A point outside the crop lands outside 0..1.
 */
export function toReelPoint(analysis: Pick<ShotAnalysis, "width" | "height" | "reframe">, p: FramePoint, t: number, cropAt?: (t: number) => { x: number; y: number }): FramePoint {
  const aspect = analysis.width / analysis.height;
  if (aspect > REEL_ASPECT) {
    const w = REEL_ASPECT / aspect; // crop width, source fractions
    const centre = cropAt ? cropAt(t).x : analysis.reframe ? cropCentreAt(analysis.reframe.path, t, w).x : 0.5;
    const left = Math.min(1 - w, Math.max(0, centre - w / 2));
    return { x: (p.x - left) / w, y: p.y };
  }
  const h = aspect / REEL_ASPECT; // crop height, source fractions (a source taller than 9:16)
  const top = (1 - h) / 2;
  return { x: p.x, y: (p.y - top) / h };
}

/** The crop centre at `t` from smoothed keys (linear between keys, held past the ends), kept inside the frame. */
export function cropCentreAt(path: readonly CropKey[], t: number, cropWidth = 1): { x: number; y: number } {
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

/** Distance between two reel-frame points in units of the reel frame's WIDTH (the grammar's measure). */
export function eyeTraceDistance(a: FramePoint, b: FramePoint): number {
  const dx = a.x - b.x, dy = (a.y - b.y) / REEL_ASPECT; // a frame height is 16/9 widths
  return Math.hypot(dx, dy);
}

/**
 * The eye-trace distance of a cut from `outgoing` at its source time `outMs` (the last frame shown) to `incoming` at
 * `inMs` (the first frame shown), in reel-frame widths, with both attention points. `ok` when within the limit.
 */
export function cutEyeTrace(outgoing: ShotAnalysis, outMs: number, incoming: ShotAnalysis, inMs: number, limit = EYE_TRACE_LIMIT): { distance: number; ok: boolean; from: FramePoint; to: FramePoint } | null {
  const a = sampleAt(outgoing.samples, outMs), b = sampleAt(incoming.samples, inMs);
  if (!a || !b) return null;
  const from = toReelPoint(outgoing, a.saliency, outMs), to = toReelPoint(incoming, b.saliency, inMs);
  const distance = round3(eyeTraceDistance(from, to));
  return { distance, ok: distance <= limit, from: { x: round3(from.x), y: round3(from.y) }, to: { x: round3(to.x), y: round3(to.y) } };
}

// ---------------------------------------------------------------------------
// The summary the director and MCP see
// ---------------------------------------------------------------------------

export type ShotDigest = {
  durationMs: number;
  landscape: boolean;
  /** Best window per planner length: [startMs, endMs, score]. */
  best: Record<string, [number, number, number]>;
  motion: { from: number; to: number; dir: FlowDirection; mover: Mover; speed: number }[];
  peaks: number[];
  occluders: { from: number; to: number; peak: number; dir: string; coverage: number }[];
  closeUps: number;
  palette: string[];
  round: boolean;
  ramps: { at: number; kind: "up" | "down" }[];
  meanSharpness: number;
  meanAesthetic: number | null;
};

/** A compact, model-friendly digest of an analysis (a few hundred bytes), for `describeReel`, the reel summary and MCP. */
export function digestShotAnalysis(analysis: ShotAnalysis): ShotDigest {
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const aesthetic = analysis.samples.flatMap((s) => (s.aesthetic === undefined ? [] : [s.aesthetic]));
  return {
    durationMs: analysis.durationMs,
    landscape: analysis.width > analysis.height,
    best: Object.fromEntries(analysis.windows.filter((set) => set.best.length).map((set) => [String(set.lengthMs), [set.best[0].startMs, set.best[0].endMs, set.best[0].score] as [number, number, number]])),
    motion: analysis.motion.map((m) => ({ from: m.startMs, to: m.endMs, dir: m.direction, mover: m.mover, speed: round3(m.magnitude) })),
    peaks: analysis.flowPeaks.map((p) => p.t),
    occluders: analysis.occluders.map((o) => ({ from: o.startMs, to: o.endMs, peak: o.peakMs, dir: o.direction, coverage: round3(o.coverage) })),
    closeUps: analysis.reframe?.closeUps.length ?? 0,
    palette: analysis.scene.palette.slice(0, 3).map((c) => c.hex),
    round: Boolean(analysis.scene.round && analysis.scene.round.score >= 0.5),
    ramps: analysis.scene.brightnessRamps.map((r) => ({ at: r.startMs, kind: r.kind })),
    meanSharpness: round3(mean(analysis.samples.map((s) => s.sharpness))),
    meanAesthetic: aesthetic.length ? round3(mean(aesthetic)) : null,
  };
}

/** One line for a text prompt: "best 1.5s 3250–4750 (0.81); right pan by camera 0–6000; occluder 7200–7900 →; 2 close-ups". */
export function describeShotAnalysis(analysis: ShotAnalysis): string {
  const d = digestShotAnalysis(analysis);
  const parts: string[] = [];
  const best = Object.entries(d.best).map(([length, [from, to, score]]) => `${(Number(length) / 1000).toFixed(1)}s ${from}–${to} (${score.toFixed(2)})`);
  if (best.length) parts.push(`best ${best.join(", ")}`);
  const moves = d.motion.filter((m) => m.dir !== "static").map((m) => `${m.dir} by ${m.mover} ${m.from}–${m.to}`);
  parts.push(moves.length ? `motion ${moves.join(", ")}` : "static");
  if (d.peaks.length) parts.push(`action at ${d.peaks.join(", ")}`);
  if (d.occluders.length) parts.push(`occluders ${d.occluders.map((o) => `${o.from}–${o.to} ${o.dir}`).join(", ")}`);
  if (d.closeUps) parts.push(`${d.closeUps} close-ups`);
  if (d.round) parts.push("round shape");
  if (d.ramps.length) parts.push(`light ${d.ramps.map((r) => `${r.kind} at ${r.at}`).join(", ")}`);
  parts.push(`sharp ${d.meanSharpness.toFixed(2)}${d.meanAesthetic === null ? "" : `, aesthetic ${d.meanAesthetic.toFixed(2)}`}`);
  return parts.join("; ");
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round4 = (value: number) => Math.round(value * 10000) / 10000;
