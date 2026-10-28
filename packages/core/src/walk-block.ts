/**
 * Walk the block (ADR 0093): a true-scale house outline and a white architect's massing, drawn on the ground of a
 * drone clip and locked to it as the drone flies, from a camera solve of the clip itself.
 *
 * The worker's solve (apps/worker/block, OpenCV) writes a `BlockSolve`: every camera of the flight in metres, with the
 * ground as y = 0 (y up, -z the first camera's heading), a sample of ground points, and how the scale was decided. This
 * module is the pure geometry both the pin screen (SVG over the still frame) and the worker's render (the same shapes,
 * rasterised onto every frame) read, so what the person places is what renders.
 *
 * Scale is one number. The solve assumes a drone height until the person states one or measures a known length; then
 * `factor` multiplies the solve's metres into true metres. Places stay in solve metres (they do not move when the scale
 * is corrected); sizes are true metres, divided by the factor where they meet the solve.
 */
import { z } from "zod";

export const BLOCK_SOLVE_VERSION = 1;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/**
 * The shortest solved flight a reveal can be drawn on, seconds: the outline draws on and the massing finishes rising by
 * 4 s (`REVEAL`), and the clip holds it a moment. The solve refuses shorter footage; a stored solve shorter than this
 * does not parse.
 */
export const MIN_REVEAL_SECONDS = 4.5;

export const blockSolveSchema = z.object({
  version: z.literal(BLOCK_SOLVE_VERSION),
  ok: z.literal(true),
  /** `fps`: the source's own frame rate; the reveal is drawn at it, frame for frame (absent on a solve written before it: 30). */
  source: z.object({ width: z.number().positive(), height: z.number().positive(), durationMs: z.number().int().min(0), solvedSeconds: z.number().positive(), fps: z.number().min(1).max(240).optional() }),
  /** The solve's frames: pixel size and pinhole intrinsics (no distortion). */
  intrinsics: z.object({ width: z.number().positive(), height: z.number().positive(), f: z.number().positive(), cx: z.number(), cy: z.number() }),
  /** One per solved frame, ascending `t` (seconds into the clip). `R` is camera-to-world, row-major (camera x right, y down, z forward). */
  cameras: z.array(z.object({ t: z.number().min(0), R: z.array(z.number()).length(9), C: vec3 })).min(2),
  /** A sample of the solved points in metres, for the ground height under a place and for picking a flat site. */
  points: z.array(vec3).max(6000),
  scale: z.object({ metresPerUnit: z.number().positive(), altitudeM: z.number().positive(), basis: z.enum(["assumed", "stated", "measured"]) }),
  ground: z.object({ inlierShare: z.number(), tiltFromGravityDeg: z.number() }),
  /** Degrees: azimuth from +x towards -z (so 90 is straight ahead of the first camera), elevation above the horizon. */
  sun: z.object({ azimuthDeg: z.number(), elevationDeg: z.number(), basis: z.enum(["assumed", "rough", "measured"]) }).loose(),
  stats: z.object({ frames: z.number(), registered: z.number(), medianReprojectionPx: z.number() }).loose(),
  /** The pin screen's still: the frame at `t`, `width` × `height` px (the source's aspect). */
  still: z.object({ t: z.number().min(0), width: z.number().positive(), height: z.number().positive() }),
}).refine((solve) => solve.cameras[solve.cameras.length - 1].t - solve.still.t >= MIN_REVEAL_SECONDS, { message: "The solved flight is too short for a reveal" });
export type BlockSolve = z.infer<typeof blockSolveSchema>;

/** What the solve writes for a clip it will not read, with a message for the person. */
export const blockRefusalSchema = z.object({ version: z.literal(BLOCK_SOLVE_VERSION), ok: z.literal(false), code: z.string().max(40), message: z.string().max(400) });
export type BlockRefusal = z.infer<typeof blockRefusalSchema>;

export function parseBlockSolve(value: unknown): { ok: true; solve: BlockSolve } | { ok: false; code: string; message: string } {
  const refused = blockRefusalSchema.safeParse(value);
  if (refused.success) return { ok: false, code: refused.data.code, message: refused.data.message };
  const solved = blockSolveSchema.safeParse(value);
  if (solved.success) return { ok: true, solve: solved.data };
  if (solved.error.issues.some((issue) => issue.message === "The solved flight is too short for a reveal")) {
    return { ok: false, code: "too-short", message: `Only part of this clip could be followed; the reveal needs ${MIN_REVEAL_SECONDS} seconds of steady flight.` };
  }
  return { ok: false, code: "unreadable", message: "The 3D reading of this clip could not be read. Try again." };
}

// ---------------------------------------------------------------------------------------------------------------- builds

export const BUILD_PRESETS = ["home", "two-storey", "pool", "land"] as const;
export type BuildPreset = (typeof BUILD_PRESETS)[number];

/** What each choice draws: sizes in true metres. A home is a gable massing; a pool a deck slab; land only its outline. */
export const BUILDS: Record<BuildPreset, { label: string; length: number; width: number; eave: number; ridge: number }> = {
  // The designed home of the au-land-maya reel: single storey, 3.0 m eaves, 5.6 m ridge.
  home: { label: "Low country home", length: 24, width: 11, eave: 3.0, ridge: 5.6 },
  "two-storey": { label: "Two-storey family home", length: 16, width: 11, eave: 6.2, ridge: 8.8 },
  pool: { label: "Pool and deck", length: 14, width: 7, eave: 0.4, ridge: 0.4 },
  land: { label: "Just the land", length: 40, width: 30, eave: 0, ridge: 0 },
};

/** A stated drone height, in metres, from the second question; null when the person is not sure. */
export const ALTITUDE_CHOICES = [30, 60, 100] as const;

/** Known lengths the person can measure on the frame, metres. */
export const KNOWN_LENGTHS = [
  { id: "road", label: "Road, two lanes", metres: 6 },
  { id: "driveway", label: "Driveway", metres: 3 },
  { id: "car", label: "Car, nose to tail", metres: 4.6 },
] as const;

export const blockPinSchema = z.object({
  build: z.enum(BUILD_PRESETS),
  /** Centre of the outline on the ground, solve metres. */
  x: z.number().min(-5000).max(5000),
  z: z.number().min(-5000).max(5000),
  /** Heading of the long side, degrees from +x towards -z. */
  yawDeg: z.number().min(-360).max(360),
  /** True metres. */
  length: z.number().min(2).max(200),
  width: z.number().min(2).max(200),
  /** Left edge of the 9:16 crop as a fraction of the room the frame leaves for it (0 left, 1 right). */
  cropX: z.number().min(0).max(1),
  sun: z.object({ azimuthDeg: z.number().min(-360).max(720), elevationDeg: z.number().min(5).max(85) }),
  /** True metres per solve metre (1: the solve's assumed height stands). */
  scale: z.object({ factor: z.number().min(0.05).max(20), basis: z.enum(["assumed", "stated", "measured"]) }),
});
export type BlockPin = z.infer<typeof blockPinSchema>;

// -------------------------------------------------------------------------------------------------------------- maths

export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly number[]; // row-major 3x3
export type Pt = [number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));
const smooth = (u: number) => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};
const ramp = (t: number, from: number, to: number) => smooth((t - from) / (to - from));

type Quat = [number, number, number, number]; // w, x, y, z

function quatFromMat(m: Mat3): Quat {
  const [a, b, c, d, e, f, g, h, i] = m;
  const tr = a + e + i;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (h - f) / s, (c - g) / s, (d - b) / s];
  } else if (a > e && a > i) {
    const s = Math.sqrt(1 + a - e - i) * 2;
    q = [(h - f) / s, 0.25 * s, (b + d) / s, (c + g) / s];
  } else if (e > i) {
    const s = Math.sqrt(1 + e - a - i) * 2;
    q = [(c - g) / s, (b + d) / s, 0.25 * s, (f + h) / s];
  } else {
    const s = Math.sqrt(1 + i - a - e) * 2;
    q = [(d - b) / s, (c + g) / s, (f + h) / s, 0.25 * s];
  }
  return q;
}

function matFromQuat([w, x, y, z]: Quat): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function slerp(a: Quat, b: Quat, u: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const q = a.map((v, k) => v + (bb[k] - v) * u) as Quat;
    const n = Math.hypot(...q);
    return q.map((v) => v / n) as Quat;
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - u) * th) / s;
  const wb = Math.sin(u * th) / s;
  return a.map((v, k) => v * wa + bb[k] * wb) as Quat;
}

export type BlockCamera = { R: number[]; C: Vec3; f: number; cx: number; cy: number };

/** The camera at `t` seconds into the clip: centre interpolated linearly, rotation by slerp, between the solved frames. Held at the ends. */
export function blockCameraAt(solve: BlockSolve, t: number): BlockCamera {
  const cams = solve.cameras;
  const { f, cx, cy } = solve.intrinsics;
  if (t <= cams[0].t) return { R: cams[0].R, C: cams[0].C, f, cx, cy };
  const last = cams[cams.length - 1];
  if (t >= last.t) return { R: last.R, C: last.C, f, cx, cy };
  let hi = 1;
  while (cams[hi].t < t) hi++;
  const a = cams[hi - 1];
  const b = cams[hi];
  const u = (t - a.t) / (b.t - a.t);
  const R = matFromQuat(slerp(quatFromMat(a.R), quatFromMat(b.R), u));
  return { R, C: add(a.C, mul(sub(b.C, a.C), u)), f, cx, cy };
}

/** World point to solve pixels, with its depth along the camera's axis. */
export function projectPoint(cam: BlockCamera, P: Vec3): { u: number; v: number; z: number } {
  const d = sub(P, cam.C);
  const R = cam.R;
  // camera coords = R^T (P - C); R is camera-to-world, row-major
  const xc = R[0] * d[0] + R[3] * d[1] + R[6] * d[2];
  const yc = R[1] * d[0] + R[4] * d[1] + R[7] * d[2];
  const zc = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];
  return { u: (xc / zc) * cam.f + cam.cx, v: (yc / zc) * cam.f + cam.cy, z: zc };
}

/** Where the ray through solve pixel (u, v) meets the level plane y = `groundY`, or null when it points at the sky. */
export function groundHit(cam: BlockCamera, u: number, v: number, groundY = 0): Vec3 | null {
  const dc: Vec3 = [(u - cam.cx) / cam.f, (v - cam.cy) / cam.f, 1];
  const R = cam.R;
  const d: Vec3 = [R[0] * dc[0] + R[1] * dc[1] + R[2] * dc[2], R[3] * dc[0] + R[4] * dc[1] + R[5] * dc[2], R[6] * dc[0] + R[7] * dc[1] + R[8] * dc[2]];
  if (d[1] >= -1e-6) return null;
  const s = (groundY - cam.C[1]) / d[1];
  return s > 0 ? add(cam.C, mul(d, s)) : null;
}

/** Height of the ground around (x, z): the 30th percentile of the solved points within `radius` m (0, the fitted plane, without enough of them). */
export function groundYAt(solve: BlockSolve, x: number, z: number, radius = 15): number {
  const ys: number[] = [];
  for (const p of solve.points) if (Math.hypot(p[0] - x, p[2] - z) < radius) ys.push(p[1]);
  if (ys.length < 6) return 0;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length * 0.3)];
}

// -------------------------------------------------------------------------------------------------------------- scale

/** True metres per solve metre when the person says how high the drone flew (at the still's moment). */
export function scaleFromAltitude(solve: BlockSolve, altitudeM: number): number {
  const cam = blockCameraAt(solve, solve.still.t);
  return altitudeM / Math.max(1e-6, cam.C[1]);
}

/**
 * True metres per solve metre from a length the person knows, measured between two points on the still (fractions of
 * the still's width and height). Null when either point is above the horizon or the two are the same place.
 */
export function scaleFromLength(solve: BlockSolve, a: Pt, b: Pt, metres: number): number | null {
  const cam = blockCameraAt(solve, solve.still.t);
  const { width, height } = solve.intrinsics;
  const pa = groundHit(cam, a[0] * width, a[1] * height);
  const pb = groundHit(cam, b[0] * width, b[1] * height);
  if (!pa || !pb) return null;
  // Cast again onto the local ground under the middle, so a slope does not bias the reading.
  const mid = mul(add(pa, pb), 0.5);
  const y = groundYAt(solve, mid[0], mid[2]);
  const qa = groundHit(cam, a[0] * width, a[1] * height, y) ?? pa;
  const qb = groundHit(cam, b[0] * width, b[1] * height, y) ?? pb;
  const d = Math.hypot(qa[0] - qb[0], qa[2] - qb[2]);
  return d > 1e-3 ? metres / d : null;
}

/** The drone's height in true metres at the still, for the readout beside the scale. */
export function altitudeAt(solve: BlockSolve, factor: number): number {
  return blockCameraAt(solve, solve.still.t).C[1] * factor;
}

// ---------------------------------------------------------------------------------------------------------- the frame

export const OUTPUT = { width: 1080, height: 1920, fps: 30 } as const;

/** The part of the solve's frame that fills the 9:16 output at `t`: a window in solve pixels. */
export type ViewWindow = { x: number; y: number; w: number; h: number };

/** How long the reveal clip runs, ms: 8 s, or as much of the solved flight as there is (at least `MIN_REVEAL_SECONDS`). */
export const REVEAL_END_MARGIN_S = 0.15;

export function revealDurationMs(solve: BlockSolve): number {
  // Never past the last solved camera (the drawing would freeze while the footage flies on), nor into the clip's last
  // `REVEAL_END_MARGIN_S`: a decode resampled right up to the end of a file comes out a frame or two short.
  const solved = solve.cameras[solve.cameras.length - 1].t - solve.still.t;
  const footage = solve.source.durationMs / 1000 - solve.still.t - REVEAL_END_MARGIN_S;
  return Math.floor(Math.min(8, solved, footage > 0 ? footage : solved) * 1000);
}

/**
 * The reveal's frame rate: the source's, at most 30 (the reels pipeline's own rate; an 8 s reveal at 120 fps would be
 * four times the frames and bytes for nothing a reel shows). The decode resamples to it.
 */
export const REVEAL_MAX_FPS = 30;
export const revealFps = (solve: BlockSolve): number => Math.min(REVEAL_MAX_FPS, solve.source.fps ?? REVEAL_MAX_FPS);

/** The 9:16 crop at no zoom, for `cropX`. */
export function baseWindow(solve: BlockSolve, cropX: number): ViewWindow {
  const { width, height } = solve.intrinsics;
  const w = Math.min(width, (height * OUTPUT.width) / OUTPUT.height);
  return { x: Math.min(1, Math.max(0, cropX)) * (width - w), y: 0, w, h: (w * OUTPUT.height) / OUTPUT.width };
}

/** The crop that puts solve-pixel `u` in the middle of the 9:16 frame, as `cropX`. */
export function cropXFor(solve: BlockSolve, u: number): number {
  const { width, height } = solve.intrinsics;
  const w = Math.min(width, (height * OUTPUT.width) / OUTPUT.height);
  return width - w <= 0 ? 0.5 : Math.min(1, Math.max(0, (u - w / 2) / (width - w)));
}

/**
 * The push-in towards the house (build stages addendum): none before the outline appears (never a push into empty
 * ground), then eased in so that by the time the walls close the house spans `span` of the frame's width (2.5× at most:
 * a 4K source's 9:16 crop is then 486 px wide, upscaled 2.2×), held to the end. As it pushes, the crop is steered so the
 * house settles at `focusX`, `focusY` of the frame: centred, a little low, clear of the title at 0.16 and of the
 * like/share column on the right. Short clips compress it with the stages (`revealBeats`).
 */
export const PUSH_IN = { max: 2.5, span: 0.35, focusX: 0.5, focusY: 0.58 } as const;

/** How far the reveal pushes in, for this pin: the house's width on screen when the walls start to close, against `span`. */
export function pushInFor(solve: BlockSolve, pin: BlockPin): number {
  const base = baseWindow(solve, pin.cropX);
  const beats = revealBeats(revealDurationMs(solve));
  const cam = blockCameraAt(solve, solve.still.t + beats.clad[0] / 1000);
  const us = footprintCorners(solve, pin).map((p) => projectPoint(cam, p)).filter((q) => q.z > 0).map((q) => q.u);
  if (us.length < 4) return 1;
  const spanPx = ((Math.max(...us) - Math.min(...us)) * OUTPUT.width) / base.w;
  return Math.min(PUSH_IN.max, Math.max(1, (PUSH_IN.span * OUTPUT.width) / Math.max(1, spanPx)));
}

/** How far the push has gone at `tMs`: 0 until the outline starts to draw, 1 when the walls start to close, eased both ends. */
export function pushProgress(solve: BlockSolve, tMs: number): number {
  const beats = revealBeats(revealDurationMs(solve));
  return ramp(tMs, beats.outline[0], beats.clad[0]);
}

/**
 * The part of the solve's frame the output shows at `tMs`: the 9:16 crop, pushed in and steered towards the house. A
 * fractional window: the worker crops the source to it exactly (sub-pixel), and every shape is projected through it, so
 * the drawing stays on the ground whatever the crop does.
 */
export function viewAt(solve: BlockSolve, pin: BlockPin, tMs: number): ViewWindow {
  const base = baseWindow(solve, pin.cropX);
  const { width, height } = solve.intrinsics;
  const p = pushProgress(solve, tMs);
  const zoom = 1 + (pushInFor(solve, pin) - 1) * p;
  const w = base.w / zoom;
  const h = base.h / zoom;
  const cam = blockCameraAt(solve, solve.still.t + tMs / 1000);
  const c = projectPoint(cam, [pin.x, groundYAt(solve, pin.x, pin.z), pin.z]);
  // from the base crop's middle (p = 0: exactly the base crop) to the house at its focus point (p = 1)
  const fromX = base.x + (base.w - w) / 2;
  const fromY = (base.h - h) / 2;
  const toX = c.z > 0 ? c.u - PUSH_IN.focusX * w : fromX;
  const toY = c.z > 0 ? c.v - PUSH_IN.focusY * h : fromY;
  const x = Math.min(width - w, Math.max(0, fromX + (toX - fromX) * p));
  const y = Math.min(height - h, Math.max(0, fromY + (toY - fromY) * p));
  return { x, y, w, h };
}

const toOut = (win: ViewWindow, u: number, v: number): Pt => [((u - win.x) * OUTPUT.width) / win.w, ((v - win.y) * OUTPUT.height) / win.h];

// ------------------------------------------------------------------------------------------------------- the drawing

/**
 * The reveal's beats, ms into an 8 s clip (shorter clips compress them, `revealBeats`): the outline draws on and its
 * area is written on it; then the house is built (ADR 0093, build stages): the slab is poured, the wall frame goes up
 * stud by stud, the roof trusses go on end to end, and the walls and roof close into the finished white massing.
 */
export const REVEAL = {
  outline: [300, 1300],
  fill: [600, 1400],
  labelIn: [900, 1500],
  slab: [1500, 2200],
  frame: [2200, 3500],
  roof: [3500, 4500],
  clad: [4500, 5400],
  // the area stays written on the slab while the frame goes up, and goes as the trusses go on
  labelOut: [3400, 4000],
} as const;

export type RevealBeats = { [K in keyof typeof REVEAL]: readonly [number, number] };

/** The beats for a reveal of `durationMs`: as `REVEAL` for 6 s and longer, compressed so the house is finished 0.6 s before a shorter clip ends. */
export function revealBeats(durationMs: number): RevealBeats {
  const k = Math.min(1, Math.max(0.1, (durationMs - 600) / REVEAL.clad[1]));
  return Object.fromEntries(Object.entries(REVEAL).map(([key, [a, b]]) => [key, [a * k, b * k] as const])) as RevealBeats;
}

/** Slab thickness, true metres, and the wall frame's stud and truss spacing. */
export const SLAB_M = 0.3;
export const STUD_SPACING_M = 1.2;

export type BlockShape =
  | {
      kind: "poly";
      role: "fill" | "outline" | "shadow" | "slab" | "frame" | "roof-frame" | "face" | "pool";
      points: Pt[];
      closed: boolean;
      fill: string | null;
      fillOpacity: number;
      stroke: string | null;
      strokeWidth: number;
      strokeOpacity: number;
      dash: [number, number] | null;
      blur: number;
    }
  | {
      kind: "label";
      text: string;
      sub: string;
      /** SVG matrix(a b c d e f) from label space (1 unit = 1 solve metre on the ground, x right, y towards the camera) to output pixels. */
      matrix: [number, number, number, number, number, number];
      /** Cap height of the main line in label units (solve metres). */
      size: number;
      opacity: number;
    };

export function footprintArea(pin: Pick<BlockPin, "length" | "width">): number {
  return Math.round(pin.length * pin.width);
}

function formatMetres(n: number): string {
  return Number.isInteger(Math.round(n * 10) / 10) ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1);
}

export function areaText(pin: Pick<BlockPin, "length" | "width">): { text: string; sub: string } {
  return { text: `${footprintArea(pin).toLocaleString("en-AU")} m²`, sub: `${formatMetres(pin.length)} × ${formatMetres(pin.width)} m` };
}

/** Footprint corners on the ground, solve metres, counter-clockwise seen from above. */
export function footprintCorners(solve: BlockSolve, pin: BlockPin): Vec3[] {
  const y = groundYAt(solve, pin.x, pin.z);
  const a = (pin.yawDeg * Math.PI) / 180;
  const ex: Vec3 = [Math.cos(a), 0, -Math.sin(a)];
  const ez: Vec3 = [Math.sin(a), 0, Math.cos(a)];
  const hl = pin.length / 2 / pin.scale.factor;
  const hw = pin.width / 2 / pin.scale.factor;
  const c: Vec3 = [pin.x, y, pin.z];
  return [
    add(add(c, mul(ex, -hl)), mul(ez, -hw)),
    add(add(c, mul(ex, hl)), mul(ez, -hw)),
    add(add(c, mul(ex, hl)), mul(ez, hw)),
    add(add(c, mul(ex, -hl)), mul(ez, hw)),
  ];
}

type Face = { pts: Vec3[]; n: Vec3 };

/** Faces' normals turned away from `centre`, whatever order their corners came in. */
function orientOut(faces: Face[], centre: Vec3): Face[] {
  for (const f of faces) {
    const fc = mul(f.pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / f.pts.length);
    if (dot(f.n, sub(fc, centre)) < 0) f.n = mul(f.n, -1);
  }
  return faces;
}

function makeFace(pts: Vec3[]): Face {
  return { pts, n: norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]))) };
}

const lift = (p: Vec3, h: number): Vec3 => [p[0], p[1] + h, p[2]];
const midpoint = (a: Vec3, b: Vec3): Vec3 => mul(add(a, b), 0.5);

/** The slab's (or a pool's deck's) height in solve metres, and the height the house stands on. */
function slabHeight(pin: BlockPin): number {
  if (pin.build === "land") return 0;
  return (pin.build === "pool" ? BUILDS.pool.eave : SLAB_M) / pin.scale.factor;
}

/** The slab as a box `progress` (0..1) of its height: its top and four sides, outward normals. */
function slab(solve: BlockSolve, pin: BlockPin, progress: number): Face[] {
  const h = slabHeight(pin) * progress;
  if (h <= 0) return [];
  const [p0, p1, p2, p3] = footprintCorners(solve, pin);
  const top = [p0, p1, p2, p3].map((p) => lift(p, h));
  const faces = [makeFace(top), makeFace([p0, p1, top[1], top[0]]), makeFace([p1, p2, top[2], top[1]]), makeFace([p2, p3, top[3], top[2]]), makeFace([p3, p0, top[0], top[3]])];
  return orientOut(faces, lift(midpoint(p0, p2), h / 2));
}

/** The finished massing standing on the slab: walls and a gable roof (ridge along the length), outward normals. */
function massing(solve: BlockSolve, pin: BlockPin): Face[] {
  const spec = BUILDS[pin.build];
  if (pin.build === "pool" || pin.build === "land" || spec.eave <= 0) return [];
  const base = slabHeight(pin);
  const [p0, p1, p2, p3] = footprintCorners(solve, pin).map((p) => lift(p, base));
  const k = pin.scale.factor;
  const eave = spec.eave / k;
  const ridge = spec.ridge / k;
  const faces: Face[] = [];
  // p0 → p1 runs along the length on the -z side (local), p1 → p2 across the width.
  faces.push(makeFace([p0, lift(p0, eave), lift(p1, eave), p1]));
  faces.push(makeFace([p2, lift(p2, eave), lift(p3, eave), p3]));
  const r03 = lift(midpoint(p0, p3), ridge);
  const r12 = lift(midpoint(p1, p2), ridge);
  faces.push(makeFace([p1, lift(p1, eave), r12, lift(p2, eave), p2]));
  faces.push(makeFace([p3, lift(p3, eave), r03, lift(p0, eave), p0]));
  if (ridge > eave + 1e-6) {
    faces.push(makeFace([lift(p0, eave), r03, r12, lift(p1, eave)]));
    faces.push(makeFace([lift(p2, eave), r12, r03, lift(p3, eave)]));
  } else {
    faces.push(makeFace([lift(p0, eave), lift(p3, eave), lift(p2, eave), lift(p1, eave)]));
  }
  return orientOut(faces, lift(midpoint(p0, p2), eave / 2));
}

/** One member of the frame: a line in the world, the normal of the wall or roof it belongs to (for the sun), how far it has gone up, and how thick it is. */
type Member = { a: Vec3; b: Vec3; n: Vec3; shown: number; heavy: boolean };

/**
 * The wall frame at `progress`: studs every `STUD_SPACING_M` around the walls, each rising in turn around the perimeter
 * (the last starting at 60% of the beat), then the top plates (and a floor plate between two storeys) at the end.
 */
function wallFrame(solve: BlockSolve, pin: BlockPin, progress: number): Member[] {
  const spec = BUILDS[pin.build];
  if (progress <= 0 || pin.build === "pool" || pin.build === "land") return [];
  const k = pin.scale.factor;
  const base = slabHeight(pin);
  const corners = footprintCorners(solve, pin).map((p) => lift(p, base));
  const centre = midpoint(corners[0], corners[2]);
  const eave = spec.eave / k;
  const studs: { at: Vec3; n: Vec3 }[] = [];
  for (let e = 0; e < 4; e++) {
    const a = corners[e];
    const b = corners[(e + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]) * k;
    const count = Math.min(40, Math.max(1, Math.round(len / STUD_SPACING_M)));
    const out = sub(midpoint(a, b), centre);
    const n = norm([out[0], 0, out[2]]);
    for (let i = 0; i < count; i++) studs.push({ at: add(a, mul(sub(b, a), i / count)), n });
  }
  const members: Member[] = studs.map((s, i) => {
    const grown = Math.min(1, Math.max(0, (progress - (0.6 * i) / studs.length) / 0.4));
    return { a: s.at, b: lift(s.at, eave * smooth(grown)), n: s.n, shown: grown, heavy: false };
  });
  const plates = ramp(progress, 0.85, 1);
  if (plates > 0) {
    const levels = spec.eave > 4.5 ? [eave / 2, eave] : [eave];
    for (const h of levels)
      for (let e = 0; e < 4; e++) {
        const a = lift(corners[e], h);
        const b = lift(corners[(e + 1) % 4], h);
        const out = sub(midpoint(a, b), lift(centre, h));
        members.push({ a, b: add(a, mul(sub(b, a), plates)), n: norm([out[0], 0, out[2]]), shown: 1, heavy: true });
      }
  }
  return members;
}

/** The roof frame at `progress`: gable trusses every `STUD_SPACING_M` along the length, set end to end, then the ridge. */
function roofFrame(solve: BlockSolve, pin: BlockPin, progress: number): Member[] {
  const spec = BUILDS[pin.build];
  if (progress <= 0 || pin.build === "pool" || pin.build === "land" || spec.ridge <= spec.eave) return [];
  const k = pin.scale.factor;
  const base = slabHeight(pin);
  const [p0, p1, p2, p3] = footprintCorners(solve, pin).map((p) => lift(p, base));
  const eave = spec.eave / k;
  const ridge = spec.ridge / k;
  const len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) * k;
  const count = Math.min(40, Math.max(2, Math.round(len / STUD_SPACING_M) + 1));
  const slopeA = norm(cross(sub(lift(midpoint(p1, p2), ridge), lift(p1, eave)), sub(lift(p0, eave), lift(p1, eave))));
  const up: Vec3 = [0, 1, 0];
  const members: Member[] = [];
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    const shown = Math.min(1, Math.max(0, (progress - 0.7 * u) / 0.3));
    if (shown <= 0) continue;
    const left = lift(add(p0, mul(sub(p1, p0), u)), eave);
    const right = lift(add(p3, mul(sub(p2, p3), u)), eave);
    const top = lift(midpoint(add(p0, mul(sub(p1, p0), u)), add(p3, mul(sub(p2, p3), u))), ridge);
    const t = smooth(shown);
    members.push({ a: left, b: add(left, mul(sub(top, left), t)), n: slopeA[1] >= 0 ? slopeA : mul(slopeA, -1), shown, heavy: false });
    members.push({ a: right, b: add(right, mul(sub(top, right), t)), n: up, shown, heavy: false });
    members.push({ a: left, b: right, n: up, shown, heavy: false });
  }
  const ridgeP = ramp(progress, 0.7, 1);
  if (ridgeP > 0) {
    const r0 = lift(midpoint(p0, p3), ridge);
    const r1 = lift(midpoint(p1, p2), ridge);
    members.push({ a: r0, b: add(r0, mul(sub(r1, r0), ridgeP)), n: up, shown: 1, heavy: true });
  }
  return members;
}

export function sunVector(sun: BlockPin["sun"]): Vec3 {
  const a = (sun.azimuthDeg * Math.PI) / 180;
  const e = (sun.elevationDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a)];
}

function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const crossZ = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The model's white (or `base`), shaded by the sun: a face turned to it is bright, one turned away keeps 74% (a sky-lit side). */
function shade(n: Vec3, sun: Vec3, base: [number, number, number] = [246, 243, 236]): string {
  const lit = 0.74 + 0.26 * Math.max(0, dot(n, sun));
  const c = (v: number) => Math.round(Math.min(255, v * lit));
  return `rgb(${c(base[0])},${c(base[1])},${c(base[2])})`;
}

/** The part of a closed outline from its start to `p` (0..1) of its perimeter. */
function partialOutline(points: Pt[], p: number): Pt[] {
  const ring = [...points, points[0]];
  const lens = ring.slice(1).map((q, i) => Math.hypot(q[0] - ring[i][0], q[1] - ring[i][1]));
  let left = lens.reduce((s, l) => s + l, 0) * Math.min(1, Math.max(0, p));
  const out: Pt[] = [ring[0]];
  for (let i = 0; i < lens.length && left > 0; i++) {
    if (left >= lens[i]) {
      out.push(ring[i + 1]);
      left -= lens[i];
    } else {
      const u = left / lens[i];
      out.push([ring[i][0] + (ring[i + 1][0] - ring[i][0]) * u, ring[i][1] + (ring[i + 1][1] - ring[i][1]) * u]);
      left = 0;
    }
  }
  return out;
}

export type DrawOptions = {
  /** Draw everything at its end state (the pin screen): outline, fill, label and, for `rise` (0..1), the house built that far. */
  still?: { rise: number; label: boolean };
  /** The window of solve pixels the output shows; defaults to `viewAt`. The pin screen passes the still's crop. */
  window?: ViewWindow;
};

/** How far each stage is at `tMs` (0..1). */
export function stagesAt(solve: BlockSolve, pin: BlockPin, tMs: number, still?: DrawOptions["still"]) {
  if (still) {
    const r = still.rise;
    return { outline: 1, fill: 1, label: still.label ? 1 : 0, slab: r > 0 ? 1 : 0, frame: r, roof: r, clad: r };
  }
  const b = revealBeats(revealDurationMs(solve));
  const r = (beat: readonly [number, number]) => ramp(tMs, beat[0], beat[1]);
  return {
    outline: r(b.outline),
    fill: r(b.fill),
    label: r(b.labelIn) * (pin.build === "land" ? 1 : 1 - r(b.labelOut)),
    slab: r(b.slab),
    frame: r(b.frame),
    roof: r(b.roof),
    clad: r(b.clad),
  };
}

/**
 * Everything drawn over the frame `tMs` into the reveal, in output pixels (1080 × 1920), back to front: the outline's
 * fill, the massing's shadow, the outline, the slab, the area label on it, the wall and roof frames, the massing's
 * visible faces closing over them, then a pool's water on top of its deck. A shape behind the camera is left out.
 * Every stage is drawn from the solved camera of its moment (locked to the ground) and shaded by the pinned sun.
 */
export function drawBlock(solve: BlockSolve, pin: BlockPin, tMs: number, options: DrawOptions = {}): BlockShape[] {
  const cam = blockCameraAt(solve, solve.still.t + tMs / 1000);
  const win = options.window ?? viewAt(solve, pin, tMs);
  const P = (p: Vec3): Pt | null => {
    const q = projectPoint(cam, p);
    return q.z > 0.5 ? toOut(win, q.u, q.v) : null;
  };
  const all = (ps: Vec3[]): Pt[] | null => {
    const out = ps.map(P);
    return out.every((p) => p !== null) ? (out as Pt[]) : null;
  };
  const st = stagesAt(solve, pin, tMs, options.still);
  const corners = footprintCorners(solve, pin);
  const ground = all(corners);
  const shapes: BlockShape[] = [];
  if (!ground) return shapes;
  const width = OUTPUT.width / 1080;
  const sun = sunVector(pin.sun);
  const poly = (role: Extract<BlockShape, { kind: "poly" }>["role"], points: Pt[], rest: Partial<Extract<BlockShape, { kind: "poly" }>>): BlockShape => ({
    kind: "poly", role, points, closed: true, fill: null, fillOpacity: 0, stroke: null, strokeWidth: 0, strokeOpacity: 0, dash: null, blur: 0, ...rest,
  });
  const facing = (f: Face) => dot(f.n, sub(cam.C, mul(f.pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / f.pts.length))) > 0;

  if (st.fill > 0) shapes.push(poly("fill", ground, { fill: "#F3EDE2", fillOpacity: 0.3 * st.fill }));

  // The massing's shadow: faint while the frame and trusses stand, full as the walls close.
  const faces = massing(solve, pin);
  const shadowP = 0.34 * st.clad + 0.1 * st.roof * (1 - st.clad);
  if (faces.length > 0 && sun[1] > 0.05 && shadowP > 0) {
    const cast: Pt[] = [];
    const y0 = corners[0][1];
    for (const f of faces)
      for (const v of f.pts) {
        const q = P(add(v, mul(sun, -(v[1] - y0) / sun[1])));
        if (q) cast.push(q);
      }
    for (const g of ground) cast.push(g);
    if (cast.length >= 3) shapes.push(poly("shadow", hull(cast), { fill: "#000000", fillOpacity: shadowP, blur: 3 }));
  }

  if (st.outline > 0) {
    const points = st.outline >= 1 ? ground : partialOutline(ground, st.outline);
    // the slab is poured over it: the dashed line would otherwise show as a seam along the slab's foot
    const under = pin.build === "land" ? 1 : 1 - st.slab;
    if (under > 0) shapes.push(poly("outline", points, { closed: st.outline >= 1, stroke: "#FFFFFF", strokeWidth: 4 * width, strokeOpacity: 0.95 * under, dash: [22 * width, 12 * width] }));
  }

  // The slab (a pool's deck), poured: concrete, lit by the sun.
  for (const f of slab(solve, pin, st.slab)) {
    if (!facing(f)) continue;
    const pts = all(f.pts);
    if (pts) shapes.push(poly("slab", pts, { fill: shade(f.n, sun, [222, 218, 210]), fillOpacity: 1, stroke: "#6B675F", strokeWidth: 1.2 * width, strokeOpacity: 0.4 }));
  }

  if (st.label > 0) {
    const label = labelOnGround(solve, pin, cam, win, slabHeight(pin) * st.slab);
    if (label) shapes.push({ ...label, opacity: st.label });
  }

  // The frame and the trusses, white like the model, each member lit like the wall or roof it belongs to; they fade as
  // the walls close over them.
  const frameOpacity = 1 - st.clad;
  if (frameOpacity > 0) {
    for (const [role, members] of [["frame", wallFrame(solve, pin, st.frame)], ["roof-frame", roofFrame(solve, pin, st.roof)]] as const) {
      for (const m of members) {
        if (m.shown <= 0) continue;
        const pts = all([m.a, m.b]);
        if (!pts) continue;
        shapes.push(poly(role, pts, { closed: false, stroke: shade(m.n, sun), strokeWidth: (m.heavy ? 2.6 : 1.8) * width, strokeOpacity: 0.95 * frameOpacity * Math.min(1, m.shown * 2) }));
      }
    }
  }

  // The walls and roof closing into the finished white massing.
  if (st.clad > 0) {
    for (const f of faces) {
      if (!facing(f)) continue;
      const pts = all(f.pts);
      if (pts) shapes.push(poly("face", pts, { fill: shade(f.n, sun), fillOpacity: st.clad, stroke: "#5A5650", strokeWidth: 1.4 * width, strokeOpacity: 0.45 * st.clad }));
    }
  }

  if (pin.build === "pool" && st.fill > 0) {
    // the pool itself: 70% of the deck's length, 55% of its width, towards one end. Drawn after the deck's faces, on
    // its top, so the opaque deck does not cover it.
    const k = pin.scale.factor;
    const a = (pin.yawDeg * Math.PI) / 180;
    const ex: Vec3 = [Math.cos(a), 0, -Math.sin(a)];
    const ez: Vec3 = [Math.sin(a), 0, Math.cos(a)];
    const y = corners[0][1] + slabHeight(pin) * st.slab + 0.01;
    const c: Vec3 = add([pin.x, y, pin.z], mul(ex, (-0.1 * pin.length) / k));
    const hl = (0.35 * pin.length) / k;
    const hw = (0.275 * pin.width) / k;
    const water = all([add(add(c, mul(ex, -hl)), mul(ez, -hw)), add(add(c, mul(ex, hl)), mul(ez, -hw)), add(add(c, mul(ex, hl)), mul(ez, hw)), add(add(c, mul(ex, -hl)), mul(ez, hw))]);
    if (water) shapes.push(poly("pool", water, { fill: "#6FB7C9", fillOpacity: 0.85 * Math.max(st.fill, st.slab), stroke: "#FFFFFF", strokeWidth: 2 * width, strokeOpacity: 0.6 * st.fill }));
  }
  return shapes;
}

/** The area written flat on the ground (or on the slab, `above` it) at the outline's centre, reading left to right from the camera, sized to fit inside it. */
function labelOnGround(solve: BlockSolve, pin: BlockPin, cam: BlockCamera, win: ViewWindow, above = 0): Extract<BlockShape, { kind: "label" }> | null {
  const y = groundYAt(solve, pin.x, pin.z) + above;
  const c: Vec3 = [pin.x, y, pin.z];
  const a = (pin.yawDeg * Math.PI) / 180;
  const along: Vec3 = [Math.cos(a), 0, -Math.sin(a)];
  const across: Vec3 = [Math.sin(a), 0, Math.cos(a)];
  const at = (p: Vec3) => {
    const q = projectPoint(cam, p);
    return q.z > 0.5 ? toOut(win, q.u, q.v) : null;
  };
  const o = at(c);
  if (!o) return null;
  // Write along whichever side of the outline runs more across the screen.
  const pa = at(add(c, along));
  const pc = at(add(c, across));
  if (!pa || !pc) return null;
  const useAlong = Math.abs(pa[0] - o[0]) * Math.hypot(pc[0] - o[0], pc[1] - o[1]) >= Math.abs(pc[0] - o[0]) * Math.hypot(pa[0] - o[0], pa[1] - o[1]);
  let ex = useAlong ? along : across;
  let lengthM = useAlong ? pin.length : pin.width;
  let depthM = useAlong ? pin.width : pin.length;
  const sx = at(add(c, ex));
  if (!sx) return null;
  if (sx[0] < o[0]) ex = mul(ex, -1);
  let ey: Vec3 = [-ex[2], 0, ex[0]];
  const sy0 = at(add(c, ey));
  if (!sy0) return null;
  if (sy0[1] < o[1]) ey = mul(ey, -1);
  const p1 = at(add(c, ex));
  const p2 = at(add(c, ey));
  if (!p1 || !p2) return null;
  const k = pin.scale.factor;
  lengthM /= k;
  depthM /= k;
  // Playfair's figures average ~0.52 em and the line is set at 1.45 cap heights, so a line of n characters is ~0.75 n
  // caps wide: as large as fits, inside 92% of the side it runs along and half the other.
  const { text } = areaText(pin);
  const size = Math.min((0.92 * lengthM) / (0.754 * text.length), 0.5 * depthM);
  // Just the area: the "24 × 11 m" line under it was unreadable at a drone's distance (the dimensions are on the pin screen).
  return { kind: "label", text, sub: "", matrix: [p1[0] - o[0], p1[1] - o[1], p2[0] - o[0], p2[1] - o[1], o[0], o[1]], size, opacity: 1 };
}

// ---------------------------------------------------------------------------------------------------------- the site

/**
 * A first place for the outline: open, level ground (no solved points standing more than 1.2 m above it) that stays
 * inside the 9:16 crop for the whole reveal, as near the middle of the frame as possible. Returns the pin's x, z, a yaw
 * square to the camera's heading and the crop that centres it. Null when nothing qualifies (then the pin screen puts the
 * outline in the middle of the frame for the person to move).
 */
export function suggestSite(solve: BlockSolve, build: BuildPreset, factor = 1): Pick<BlockPin, "x" | "z" | "yawDeg" | "cropX"> | null {
  const cam0 = blockCameraAt(solve, solve.still.t);
  const { width, height } = solve.intrinsics;
  const spec = BUILDS[build];
  const yawDeg = headingDeg(cam0);
  const dur = revealDurationMs(solve);
  let best: { score: number; x: number; z: number; cropX: number } | null = null;
  for (let gv = 0.5; gv <= 0.92; gv += 0.035) {
    for (let gu = 0.12; gu <= 0.88; gu += 0.035) {
      const hit = groundHit(cam0, gu * width, gv * height);
      if (!hit) continue;
      const near = solve.points.filter((p) => Math.hypot(p[0] - hit[0], p[2] - hit[2]) < (Math.max(spec.length, spec.width) * 0.75) / factor);
      if (near.length < 8) continue;
      const ys = near.map((p) => p[1]).sort((a, b) => a - b);
      const base = ys[Math.floor(ys.length * 0.3)];
      const tall = near.filter((p) => p[1] - base > 1.2 / factor).length / near.length;
      const spread = ys[Math.floor(ys.length * 0.7)] - base;
      if (tall > 0.08) continue;
      const cropX = cropXFor(solve, gu * width);
      const pin: BlockPin = { build, x: hit[0], z: hit[2], yawDeg, length: spec.length, width: spec.width, cropX, sun: { azimuthDeg: 135, elevationDeg: 35 }, scale: { factor, basis: "assumed" } };
      let inside = 0;
      let samples = 0;
      for (let t = 0; t <= dur; t += 500) {
        samples++;
        const win = baseWindow(solve, cropX);
        const cam = blockCameraAt(solve, solve.still.t + t / 1000);
        const ok = footprintCorners(solve, pin).every((p) => {
          const q = projectPoint(cam, p);
          return q.z > 0 && q.u > win.x + 0.08 * win.w && q.u < win.x + 0.92 * win.w && q.v > 0.08 * win.h && q.v < 0.9 * win.h;
        });
        if (ok) inside++;
      }
      const stay = inside / samples;
      if (stay < 0.9) continue;
      // prefer level ground, then the lower-middle of the frame at the start (where the reveal is seen largest longest)
      const score = stay * 2 - tall * 4 - Math.min(1, spread * factor) * 0.5 - Math.abs(gv - 0.68) - 0.3 * Math.abs(gu - 0.5);
      if (!best || score > best.score) best = { score, x: hit[0], z: hit[2], cropX };
    }
  }
  return best ? { x: best.x, z: best.z, yawDeg, cropX: best.cropX } : null;
}

/** The camera's heading on the ground, degrees from +x towards -z. */
export function headingDeg(cam: BlockCamera): number {
  const fwd: Vec3 = [cam.R[2], cam.R[5], cam.R[8]];
  return (Math.atan2(-fwd[2], fwd[0]) * 180) / Math.PI;
}

/** Where a pin's centre would land if dragged to output pixel (x, y) of the still's crop, or null above the horizon. */
export function placeAt(solve: BlockSolve, win: ViewWindow, x: number, y: number): { x: number; z: number } | null {
  const cam = blockCameraAt(solve, solve.still.t);
  const u = win.x + (x / OUTPUT.width) * win.w;
  const v = win.y + (y / OUTPUT.height) * win.h;
  const hit = groundHit(cam, u, v);
  if (!hit) return null;
  const again = groundHit(cam, u, v, groundYAt(solve, hit[0], hit[2])) ?? hit;
  return { x: again[0], z: again[2] };
}

/** A pin's starting point for a solve: the suggested site (or the frame's lower middle), the build's size and the solve's sun. */
export function initialPin(solve: BlockSolve, build: BuildPreset, scale: BlockPin["scale"] = { factor: 1, basis: "assumed" }): BlockPin {
  const spec = BUILDS[build];
  const site = suggestSite(solve, build, scale.factor);
  const cam = blockCameraAt(solve, solve.still.t);
  const fallback = groundHit(cam, solve.intrinsics.width / 2, solve.intrinsics.height * 0.7);
  return {
    build,
    x: site?.x ?? fallback?.[0] ?? 0,
    z: site?.z ?? fallback?.[2] ?? -50,
    yawDeg: site?.yawDeg ?? headingDeg(cam),
    length: spec.length,
    width: spec.width,
    cropX: site?.cropX ?? 0.5,
    sun: { azimuthDeg: solve.sun.azimuthDeg, elevationDeg: solve.sun.elevationDeg },
    scale,
  };
}

// --------------------------------------------------------------------------------------------------------------- SVG

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => (Math.round(n * 100) / 100).toString();

export const LABEL_FONT = "'Playfair Display Variable', 'Playfair Display', Georgia, 'DejaVu Serif', serif";

/**
 * The shapes as one SVG document (output pixels). `labelImage`, when given, replaces the label's text with a picture of
 * it (`href`, drawn `width` × `height` label units centred on the label): the worker rasterises the text once with the
 * bundled Playfair, because the SVG rasteriser cannot read web fonts.
 */
export function blockSvg(shapes: BlockShape[], size: { width: number; height: number } = OUTPUT, labelImage?: { href: string; width: number; height: number }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${OUTPUT.width} ${OUTPUT.height}">${blockSvgBody(shapes, labelImage)}</svg>`;
}

/** The inside of `blockSvg`'s document (defs and shapes), for drawing into an SVG that already exists (the pin screen). */
export function blockSvgBody(shapes: BlockShape[], labelImage?: { href: string; width: number; height: number }): string {
  const parts: string[] = [];
  let blurId = 0;
  const defs: string[] = [];
  for (const s of shapes) {
    if (s.kind === "poly") {
      const d = s.points.map((p, i) => `${i ? "L" : "M"}${num(p[0])} ${num(p[1])}`).join("") + (s.closed ? "Z" : "");
      let filter = "";
      if (s.blur > 0) {
        const id = `b${blurId++}`;
        defs.push(`<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${num(s.blur)}"/></filter>`);
        filter = ` filter="url(#${id})"`;
      }
      parts.push(
        `<path d="${d}" fill="${s.fill ?? "none"}"${s.fill ? ` fill-opacity="${num(s.fillOpacity)}"` : ""}` +
          (s.stroke ? ` stroke="${s.stroke}" stroke-width="${num(s.strokeWidth)}" stroke-opacity="${num(s.strokeOpacity)}" stroke-linejoin="round" stroke-linecap="round"` : "") +
          (s.dash ? ` stroke-dasharray="${num(s.dash[0])} ${num(s.dash[1])}"` : "") +
          `${filter}/>`,
      );
    } else {
      const [a, b, c, d, e, f] = s.matrix.map(num);
      const inner = labelImage
        ? `<image href="${esc(labelImage.href)}" x="${num(-labelImage.width / 2)}" y="${num(-labelImage.height / 2)}" width="${num(labelImage.width)}" height="${num(labelImage.height)}"/>`
        : `<text x="0" y="${num(s.size * 0.5)}" text-anchor="middle" font-family="${LABEL_FONT}" font-size="${num(s.size * 1.45)}" font-weight="500" fill="#FFFFFF">${esc(s.text)}</text>` +
          (s.sub ? `<text x="0" y="${num(s.size * 1.4)}" text-anchor="middle" font-family="${LABEL_FONT}" font-size="${num(s.size * 0.62)}" fill="#FFFFFF" fill-opacity="0.9">${esc(s.sub)}</text>` : "");
      parts.push(`<g transform="matrix(${a} ${b} ${c} ${d} ${e} ${f})" opacity="${num(s.opacity)}">${inner}</g>`);
    }
  }
  return `${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${parts.join("")}`;
}

/** The label's picture size in label units for a label `size`: what `blockSvg`'s `labelImage` should be drawn at. */
export function labelImageSize(size: number): { width: number; height: number } {
  return { width: size * 9, height: size * 3.2 };
}

// ------------------------------------------------------------------------------------------------------------ storage

/** Where the worker keeps a clip's solve and still, beside nothing else of the asset's, so a re-solve replaces them. */
export const blockSolveKeyFor = (assetId: string): string => `blocks/${assetId}/solve.v${BLOCK_SOLVE_VERSION}.json`;
export const blockStillKeyFor = (assetId: string): string => `blocks/${assetId}/still.v${BLOCK_SOLVE_VERSION}.jpg`;
