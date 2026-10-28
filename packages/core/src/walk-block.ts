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
 * The push-in over the clip, eased: at least 1.16, and more for a far-off outline, until it spans about a third of the
 * frame's width at the end of the clip (the prototype's reveal pushed to 1.42), never past 1.45 (a 4K source is then
 * upscaled about 1.3×).
 */
export const PUSH_IN = { min: 1.16, max: 1.45, span: 0.32 } as const;

/** How far the reveal pushes in by its end, for this pin. */
export function pushInFor(solve: BlockSolve, pin: BlockPin): number {
  const base = baseWindow(solve, pin.cropX);
  const cam = blockCameraAt(solve, solve.still.t + revealDurationMs(solve) / 1000);
  const us = footprintCorners(solve, pin).map((p) => projectPoint(cam, p)).filter((q) => q.z > 0).map((q) => q.u);
  if (us.length < 4) return PUSH_IN.min;
  const spanPx = ((Math.max(...us) - Math.min(...us)) * OUTPUT.width) / base.w;
  return Math.min(PUSH_IN.max, Math.max(PUSH_IN.min, (PUSH_IN.span * OUTPUT.width) / Math.max(1, spanPx)));
}

export function viewAt(solve: BlockSolve, pin: BlockPin, tMs: number): ViewWindow {
  const base = baseWindow(solve, pin.cropX);
  const dur = revealDurationMs(solve);
  const zoom = 1 + (pushInFor(solve, pin) - 1) * smooth(tMs / dur);
  const cam = blockCameraAt(solve, solve.still.t + tMs / 1000);
  const c = projectPoint(cam, [pin.x, groundYAt(solve, pin.x, pin.z), pin.z]);
  const fu = c.z > 0 ? Math.min(base.x + base.w, Math.max(base.x, c.u)) : base.x + base.w / 2;
  const fv = c.z > 0 ? Math.min(base.h, Math.max(0, c.v)) : base.h / 2;
  const w = base.w / zoom;
  const h = base.h / zoom;
  const x = Math.min(base.x + base.w - w, Math.max(base.x, fu - (fu - base.x) / zoom));
  const y = Math.min(base.h - h, Math.max(0, fv - fv / zoom));
  return { x, y, w, h };
}

const toOut = (win: ViewWindow, u: number, v: number): Pt => [((u - win.x) * OUTPUT.width) / win.w, ((v - win.y) * OUTPUT.height) / win.h];

// ------------------------------------------------------------------------------------------------------- the drawing

/** The reveal's beats, ms into the clip: the outline draws on, its area is written on it, then the massing rises. */
export const REVEAL = {
  outline: [300, 1300],
  fill: [600, 1400],
  labelIn: [900, 1500],
  labelOut: [2400, 3000],
  rise: [2000, 4000],
} as const;

export type BlockShape =
  | {
      kind: "poly";
      role: "fill" | "outline" | "shadow" | "face" | "pool";
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

/** The massing's faces at `rise` (0 flat, 1 full height), outward normals. A home: walls and a gable roof (ridge along the length). A pool: a deck slab. */
function massing(solve: BlockSolve, pin: BlockPin, rise: number): Face[] {
  const spec = BUILDS[pin.build];
  if (spec.eave <= 0 || rise <= 0) return [];
  const [p0, p1, p2, p3] = footprintCorners(solve, pin);
  const k = pin.scale.factor;
  const eave = (spec.eave / k) * rise;
  const ridge = (spec.ridge / k) * rise;
  const up = (p: Vec3, h: number): Vec3 => [p[0], p[1] + h, p[2]];
  const mid = (a: Vec3, b: Vec3): Vec3 => mul(add(a, b), 0.5);
  const faces: Face[] = [];
  const face = (pts: Vec3[]) => {
    const n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    faces.push({ pts, n });
  };
  // p0 → p1 runs along the length on the -z side (local), p1 → p2 across the width.
  face([p0, up(p0, eave), up(p1, eave), p1]);
  face([p2, up(p2, eave), up(p3, eave), p3]);
  const r01 = up(mid(p0, p3), ridge);
  const r12 = up(mid(p1, p2), ridge);
  face([p1, up(p1, eave), r12, up(p2, eave), p2]);
  face([p3, up(p3, eave), r01, up(p0, eave), p0]);
  if (ridge > eave + 1e-6) {
    face([up(p0, eave), r01, r12, up(p1, eave)]);
    face([up(p2, eave), r12, r01, up(p3, eave)]);
  } else {
    face([up(p0, eave), up(p3, eave), up(p2, eave), up(p1, eave)]);
  }
  // Normals point away from the centre, whatever order the corners came in.
  const centre = mul([p0, p1, p2, p3].reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 0.25);
  const c: Vec3 = [centre[0], centre[1] + eave / 2, centre[2]];
  for (const f of faces) {
    const fc = mul(f.pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / f.pts.length);
    if (dot(f.n, sub(fc, c)) < 0) f.n = mul(f.n, -1);
  }
  return faces;
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

/** The model's white, shaded by the sun: a face turned to it is bright, one turned away keeps 74% (a sky-lit side). */
function shade(n: Vec3, sun: Vec3): string {
  const lit = 0.74 + 0.26 * Math.max(0, dot(n, sun));
  const c = (v: number) => Math.round(Math.min(255, v * lit));
  return `rgb(${c(246)},${c(243)},${c(236)})`;
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
  /** Draw everything at its end state (the pin screen): outline, fill, label and, for `rise`, the massing. */
  still?: { rise: number; label: boolean };
  /** The window of solve pixels the output shows; defaults to `viewAt`. The pin screen passes the still's crop. */
  window?: ViewWindow;
};

/**
 * Everything drawn over the frame `tMs` into the reveal, in output pixels (1080 × 1920), back to front: the outline's
 * fill, the massing's shadow, the outline, the area label, the massing's visible faces, then a pool's water on top of
 * its deck. A shape behind the camera is left out.
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
  const still = options.still;
  const outlineP = still ? 1 : ramp(tMs, REVEAL.outline[0], REVEAL.outline[1]);
  const fillP = still ? 1 : ramp(tMs, REVEAL.fill[0], REVEAL.fill[1]);
  const labelP = still ? (still.label ? 1 : 0) : ramp(tMs, REVEAL.labelIn[0], REVEAL.labelIn[1]) * (pin.build === "land" ? 1 : 1 - ramp(tMs, REVEAL.labelOut[0], REVEAL.labelOut[1]));
  const rise = still ? still.rise : ramp(tMs, REVEAL.rise[0], REVEAL.rise[1]);
  const corners = footprintCorners(solve, pin);
  const ground = all(corners);
  const shapes: BlockShape[] = [];
  if (!ground) return shapes;
  const width = OUTPUT.width / 1080;
  const sun = sunVector(pin.sun);

  if (fillP > 0) {
    shapes.push({ kind: "poly", role: "fill", points: ground, closed: true, fill: "#F3EDE2", fillOpacity: 0.3 * fillP, stroke: null, strokeWidth: 0, strokeOpacity: 0, dash: null, blur: 0 });
  }
  const faces = massing(solve, pin, rise);
  if (faces.length > 0 && sun[1] > 0.05) {
    const cast: Pt[] = [];
    const y0 = corners[0][1];
    for (const f of faces)
      for (const v of f.pts) {
        const s = add(v, mul(sun, -(v[1] - y0) / sun[1]));
        const q = P(s);
        if (q) cast.push(q);
      }
    for (const g of ground) cast.push(g);
    if (cast.length >= 3) shapes.push({ kind: "poly", role: "shadow", points: hull(cast), closed: true, fill: "#000000", fillOpacity: 0.34 * rise, stroke: null, strokeWidth: 0, strokeOpacity: 0, dash: null, blur: 3 });
  }
  if (outlineP > 0) {
    shapes.push({
      kind: "poly",
      role: "outline",
      points: outlineP >= 1 ? ground : partialOutline(ground, outlineP),
      closed: outlineP >= 1,
      fill: null,
      fillOpacity: 0,
      stroke: "#FFFFFF",
      strokeWidth: 4 * width,
      strokeOpacity: 0.95,
      dash: [22 * width, 12 * width],
      blur: 0,
    });
  }
  if (labelP > 0) {
    const label = labelOnGround(solve, pin, cam, win);
    if (label) shapes.push({ ...label, opacity: labelP });
  }
  for (const f of faces) {
    const fc = mul(f.pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / f.pts.length);
    if (dot(f.n, sub(cam.C, fc)) <= 0) continue; // faces away from the camera
    const pts = all(f.pts);
    if (!pts) continue;
    shapes.push({ kind: "poly", role: "face", points: pts, closed: true, fill: shade(f.n, sun), fillOpacity: 1, stroke: "#5A5650", strokeWidth: 1.4 * width, strokeOpacity: 0.45, dash: null, blur: 0 });
  }
  if (pin.build === "pool" && fillP > 0) {
    // the pool itself: 70% of the deck's length, 55% of its width, towards one end. Drawn after the deck's faces, on
    // its top, so the opaque deck does not cover it.
    const k = pin.scale.factor;
    const a = (pin.yawDeg * Math.PI) / 180;
    const ex: Vec3 = [Math.cos(a), 0, -Math.sin(a)];
    const ez: Vec3 = [Math.sin(a), 0, Math.cos(a)];
    const y = corners[0][1] + (BUILDS.pool.eave / k) * rise + 0.01;
    const c: Vec3 = add([pin.x, y, pin.z], mul(ex, (-0.1 * pin.length) / k));
    const hl = (0.35 * pin.length) / k;
    const hw = (0.275 * pin.width) / k;
    const water = all([add(add(c, mul(ex, -hl)), mul(ez, -hw)), add(add(c, mul(ex, hl)), mul(ez, -hw)), add(add(c, mul(ex, hl)), mul(ez, hw)), add(add(c, mul(ex, -hl)), mul(ez, hw))]);
    if (water) shapes.push({ kind: "poly", role: "pool", points: water, closed: true, fill: "#6FB7C9", fillOpacity: 0.85 * Math.max(fillP, rise), stroke: "#FFFFFF", strokeWidth: 2 * width, strokeOpacity: 0.6 * fillP, dash: null, blur: 0 });
  }
  return shapes;
}

/** The area written flat on the ground at the outline's centre, reading left to right from the camera, sized to fit inside it. */
function labelOnGround(solve: BlockSolve, pin: BlockPin, cam: BlockCamera, win: ViewWindow): Extract<BlockShape, { kind: "label" }> | null {
  const y = groundYAt(solve, pin.x, pin.z);
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
  // Playfair's figures average ~0.52 em and the main line is set at 1.45 cap heights, so a line of n characters is ~0.75 n
  // caps wide: as large as fits, inside 92% of the side it runs along and a third of the other (the sub line may run
  // a little past it; legible from a drone's height matters more).
  const { text } = areaText(pin);
  const size = Math.min((0.92 * lengthM) / (0.754 * text.length), 0.34 * depthM);
  return { kind: "label", ...areaText(pin), matrix: [p1[0] - o[0], p1[1] - o[1], p2[0] - o[0], p2[1] - o[1], o[0], o[1]], size, opacity: 1 };
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
        : `<text x="0" y="${num(s.size * 0.35)}" text-anchor="middle" font-family="${LABEL_FONT}" font-size="${num(s.size * 1.45)}" font-weight="500" fill="#FFFFFF">${esc(s.text)}</text>` +
          `<text x="0" y="${num(s.size * 1.25)}" text-anchor="middle" font-family="${LABEL_FONT}" font-size="${num(s.size * 0.62)}" fill="#FFFFFF" fill-opacity="0.9">${esc(s.sub)}</text>`;
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
