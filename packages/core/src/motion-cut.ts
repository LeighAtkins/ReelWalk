/**
 * The motion-hidden cut (ADR 0089): a hard cut buried inside real, fast camera motion, the way the owner's reference
 * reels join shots (37 of 88 changes in reels 1, 2 and 4; output/references/report.md).
 *
 * What the references do, measured, and what this module therefore does:
 * - The join sits inside motion the footage really has. Both sides must be moving fast at the cut, in compatible
 *   directions, by the clips' own measured flow (ADR 0086 samples). Otherwise the cut is refused and stays a hard cut
 *   on the beat. That refusal is the difference from the whip retired in ADR 0082, an 8-frame smear drawn over footage
 *   that barely moved.
 * - The incoming clip starts fast and eases to 1×: its first `rampFrames` frames play from `rampFrom`× down to 1× on an
 *   ease-out, through the clip's own speed ramp (ADR 0067), so every reader of a clip's source time agrees. The clip's
 *   length on screen does not change; its source window grows by what the ramp consumes, and its sound fades where the
 *   ramp runs fast (rampGain), so nothing is sped up across the cut's audio. The music is untouched.
 * - The blur follows the measured motion vector: directional along a pan or tilt, radial about the centre for a push or
 *   a pull, sized from the speed the picture really moves at (a 180° shutter of the ramped motion), largest on the first
 *   incoming frame and gone when the ramp reaches 1×. The outgoing clip keeps its own motion blur: only its last two
 *   frames get a little more, along its own vector. No overlap, no slide, no added sound.
 * - The whole effect spans at most 2 outgoing + 10 incoming frames, inside ADR 0083's 12-frame cap, and needs no
 *   transition overlap at all: each clip draws its own frames, so the cut stays on its frame and nothing is borrowed.
 *
 * Units: flow is content motion in source frame WIDTHS a second (dx > 0 content moves right, dy > 0 down) and scale
 * growth a second (zoom > 0 push), as `sampleFlowSchema` in ADR 0086's shot-analysis.ts. A landscape source shown
 * cropped to 9:16 moves faster on screen than in its source: `reelFlow` converts.
 *
 * Pure: the editor, the commands route, the planner and the renderer share it.
 */
import { z } from "zod";
import { customRamp, rampSchema, rampWarp, type Ramp, type RampKey } from "./ramp";
import type { Clip } from "./timeline";

/** One flow reading, ADR 0086's `sampleFlowSchema` (rotate and residual are not read here). */
export type FlowLike = { dx: number; dy: number; zoom: number; magnitude?: number; rotate?: number };
/** One sample of a clip's analysis, the subset of ADR 0086's `ShotSample` this module reads. */
export type MotionSampleLike = { t: number; flow: FlowLike };

/** A motion vector in REEL frame widths a second (lateral) and scale growth a second (zoom). */
export const cutMotionSchema = z.object({
  dx: z.number().min(-20).max(20),
  dy: z.number().min(-20).max(20),
  zoom: z.number().min(-20).max(20),
});
export type CutMotion = z.infer<typeof cutMotionSchema>;

/** Measured motion either side of a motion cut, stored on the incoming clip, plus how its ramp runs. */
export const motionCutSchema = z.object({
  /** The outgoing clip's motion over its last frames, reel units. */
  out: cutMotionSchema,
  /** The incoming clip's motion over its first frames at 1×, reel units. */
  in: cutMotionSchema,
  /** The incoming clip's speed on its first frame, easing out to 1×. */
  rampFrom: z.number().min(1).max(4),
  /** Frames the ease-out takes (at 30 fps). */
  rampFrames: z.number().int().min(2).max(10),
  /** The incoming clip's speed and ramp before the cut was made: taking the cut off gives them back at the same length on screen. */
  base: z.object({ speed: z.number().min(0.25).max(4), ramp: rampSchema.nullable() }),
});
export type MotionCut = z.infer<typeof motionCutSchema>;

export const MOTION_CUT = {
  /** Both sides must move at least this fast at the cut, reel frame widths a second (zoom counts half its rate). */
  minSpeed: 0.25,
  /** The incoming side, at its ramped first-frame speed, must reach this: the references run 0.3–2.4 after the join. */
  minEntrySpeed: 0.6,
  /** Pans or tilts either side may differ by at most this angle. */
  maxAngleDeg: 60,
  /** How much of each clip next to the cut is read, ms. */
  windowMs: 300,
  /** The ease-out's default start speed and length. */
  rampFrom: 2.5,
  rampFrames: 8,
  /** Outgoing frames that get a little more of their own blur. */
  outFrames: 2,
  /** A 180° shutter: the blur is half the distance the picture moves in a frame. */
  shutter: 0.5,
  /** Ceilings, so a very fast clip still reads as a picture: Gaussian sigma in px at 1080 wide, and the zoom blur's spread. */
  maxSigmaPx: 42,
  maxZoomSpread: 0.14,
} as const;

/** The 9:16 crop's width as a share of the source width for a cover-fitted clip (1 for portrait or narrower), times its zoom. */
export function cropWidthShare(sourceAspect: number | null | undefined, zoom = 1): number {
  const reel = 9 / 16;
  const share = sourceAspect && sourceAspect > reel ? reel / sourceAspect : 1;
  return share / Math.max(1, zoom);
}

/** Source flow to reel flow: a cropped landscape moves `1 / cropWidthShare` times faster across the reel's frame. */
export function reelFlow(flow: FlowLike, sourceAspect: number | null | undefined, zoom = 1, speed = 1): CutMotion {
  const k = 1 / cropWidthShare(sourceAspect, zoom);
  return { dx: flow.dx * k * speed, dy: flow.dy * k * speed, zoom: flow.zoom * speed };
}

/** The mean flow of the samples within `windowMs` before (`side` "out") or after ("in") source time `atMs`. Null when none fall there. */
export function flowNear(samples: readonly MotionSampleLike[], atMs: number, side: "out" | "in", windowMs: number = MOTION_CUT.windowMs): FlowLike | null {
  const lo = side === "out" ? atMs - windowMs : atMs;
  const hi = side === "out" ? atMs : atMs + windowMs;
  // Samples are 250 ms apart: take those inside the window, or the nearest one when the window falls between two.
  let inside = samples.filter((sample) => sample.t >= lo && sample.t <= hi);
  if (inside.length === 0 && samples.length) {
    const mid = (lo + hi) / 2;
    const nearest = samples.reduce((best, sample) => (Math.abs(sample.t - mid) < Math.abs(best.t - mid) ? sample : best));
    if (Math.abs(nearest.t - mid) <= 250) inside = [nearest];
  }
  if (inside.length === 0) return null;
  const mean = (key: "dx" | "dy" | "zoom") => inside.reduce((sum, sample) => sum + sample.flow[key], 0) / inside.length;
  const rotate = inside.reduce((sum, sample) => sum + (sample.flow.rotate ?? 0), 0) / inside.length;
  return { dx: mean("dx"), dy: mean("dy"), zoom: mean("zoom"), rotate };
}

/** How fast a vector moves the picture's edge, frame widths a second: the pan speed, or half the zoom rate. */
export function vectorSpeed(v: CutMotion): number {
  return Math.max(Math.hypot(v.dx, v.dy), Math.abs(v.zoom) / 2);
}

/** Whether the move is mostly a push/pull (radial) or mostly a pan/tilt (lateral). */
export function vectorKind(v: CutMotion): "lateral" | "push" | "pull" {
  if (Math.abs(v.zoom) / 2 > Math.hypot(v.dx, v.dy)) return v.zoom > 0 ? "push" : "pull";
  return "lateral";
}

export type MotionCutVerdict =
  | { ok: true; out: CutMotion; in: CutMotion; how: string }
  | { ok: false; reason: string };

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const roundVector = (v: CutMotion): CutMotion => ({ dx: round3(v.dx), dy: round3(v.dy), zoom: round3(v.zoom) });

function describe(v: CutMotion): string {
  const kind = vectorKind(v);
  if (kind !== "lateral") return `${kind} ${vectorSpeed(v).toFixed(2)}`;
  const angle = (Math.atan2(v.dy, v.dx) * 180) / Math.PI;
  const name = Math.abs(angle) < 45 ? "right" : Math.abs(angle) > 135 ? "left" : angle > 0 ? "down" : "up";
  return `content ${name} ${vectorSpeed(v).toFixed(2)}`;
}

/**
 * Whether a motion cut may join these two moves (reel units), and why not when it may not. Offered only when both sides
 * really move fast, and in directions the eye can follow across the join: two pans or tilts within 60° of each other, two
 * pushes, two pulls, or a pan landing in a push (a whip resolving down a corridor, reel 1 at 12.51 s). A turn (an orbit
 * the fit reads as rotation) is refused: its blur has no single direction.
 */
export function judgeMotionCut(out: CutMotion | null, incoming: CutMotion | null, options: { rampFrom?: number; rotateOut?: number; rotateIn?: number } = {}): MotionCutVerdict {
  if (!out || !incoming) return { ok: false, reason: "No measured motion at the cut (the clips have not been analysed there)." };
  const rampFrom = options.rampFrom ?? MOTION_CUT.rampFrom;
  const so = vectorSpeed(out), si = vectorSpeed(incoming);
  if (Math.abs(options.rotateOut ?? 0) > 0.5 || Math.abs(options.rotateIn ?? 0) > 0.5) return { ok: false, reason: "One side turns (an orbit or a roll): a motion cut needs one direction. Keep the hard cut." };
  if (so < MOTION_CUT.minSpeed) return { ok: false, reason: `The outgoing shot barely moves at the cut (${so.toFixed(2)} frame widths/s; a motion cut needs ${MOTION_CUT.minSpeed}). Keep the hard cut on the beat.` };
  if (si < MOTION_CUT.minSpeed) return { ok: false, reason: `The incoming shot barely moves at its start (${si.toFixed(2)} frame widths/s; a motion cut needs ${MOTION_CUT.minSpeed}). Keep the hard cut on the beat.` };
  if (si * rampFrom < MOTION_CUT.minEntrySpeed) return { ok: false, reason: `The incoming shot is too slow even ramped (${(si * rampFrom).toFixed(2)} frame widths/s at ${rampFrom}×; it needs ${MOTION_CUT.minEntrySpeed}). Keep the hard cut on the beat.` };
  const ko = vectorKind(out), ki = vectorKind(incoming);
  const ok = { ok: true as const, out: roundVector(out), in: roundVector(incoming), how: `${describe(out)} into ${describe(incoming)}` };
  if (ko === "lateral" && ki === "lateral") {
    const cos = (out.dx * incoming.dx + out.dy * incoming.dy) / (Math.hypot(out.dx, out.dy) * Math.hypot(incoming.dx, incoming.dy));
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (angle > MOTION_CUT.maxAngleDeg) return { ok: false, reason: `The two moves go different ways (${describe(out)} then ${describe(incoming)}, ${Math.round(angle)}° apart): the eye cannot follow. Keep the hard cut.` };
    return ok;
  }
  if (ko === ki) return ok;
  if (ko === "lateral" && ki === "push") return ok;
  return { ok: false, reason: `A ${ko === "lateral" ? "pan" : ko} cannot carry into a ${ki === "lateral" ? "pan" : ki} (${describe(out)} then ${describe(incoming)}). Keep the hard cut.` };
}

/** The incoming speed (relative to 1×) `frame` frames after the cut: `rampFrom` on frame 0, easing out (quadratic) to 1 at `rampFrames`. */
export function entrySpeedAt(frame: number, rampFrom: number, rampFrames: number): number {
  if (frame >= rampFrames) return 1;
  const t = Math.max(0, frame) / rampFrames;
  return 1 + (rampFrom - 1) * (1 - t) * (1 - t);
}

/**
 * The incoming clip's speed ramp for a motion cut of `durationInFrames` frames: the ease-out written as ADR 0067 keys
 * (raw speeds; the ramp normalises its mean), plus the clip speed that makes its tail play at `baseSpeed` exactly.
 * Null when the clip is too short to hold the ease-out and a second of 1× after it.
 */
export function entryRamp(durationInFrames: number, rampFrom: number, rampFrames: number, baseSpeed = 1): { ramp: Ramp; speed: number } | null {
  if (durationInFrames < rampFrames + 8) return null;
  const n = durationInFrames;
  const keys: RampKey[] = [0, 0.25, 0.5, 0.75, 1].map((step) => ({ p: (step * rampFrames) / n, v: round3(entrySpeedAt(step * rampFrames, rampFrom, rampFrames)) }));
  keys.push({ p: 1, v: 1 });
  const ramp = customRamp(keys);
  // rampWarp(…, 1) is 1 by construction; the mean raw speed is what the source window must grow by.
  const mean = keys.slice(1).reduce((sum, key, i) => sum + ((keys[i].v + key.v) / 2) * (key.p - keys[i].p), 0);
  return { ramp, speed: Math.round(baseSpeed * mean * 10_000) / 10_000 };
}

/** Where the clip is in its source after `frame` frames of a ramp, as a check (tests): the warp of ADR 0067. */
export function rampedSourceFraction(ramp: Ramp, frame: number, durationInFrames: number): number {
  return rampWarp(ramp, frame / durationInFrames);
}

/**
 * The clip with a motion cut into it: the ramp and speed of the ease-out, its source window grown so its length on screen
 * stays the same, and the measured motion and its prior state stored on `motionCut`. Throws, with what to do, when the
 * cut cannot be made: the motion fails `judgeMotionCut`, the clip is a photo or too short, or its source runs out.
 */
export function withMotionCut(clip: Clip, verdict: Extract<MotionCutVerdict, { ok: true }>, durationInFrames: number, sourceDurationMs: number | null | undefined, options: { rampFrom?: number; rampFrames?: number } = {}): Clip {
  if (clip.kind !== "VIDEO") throw new Error("A motion cut needs video on both sides; this clip is a photo.");
  const prior = clip.motionCut?.base;
  const baseSpeed = prior?.speed ?? clip.speed;
  let rampFrom = options.rampFrom ?? MOTION_CUT.rampFrom;
  const rampFrames = options.rampFrames ?? MOTION_CUT.rampFrames;
  const onScreenMs = (clip.sourceEndMs - clip.sourceStartMs) / clip.speed;
  // Ease the start speed down until the extra source the ramp eats fits in the footage after the clip.
  for (; rampFrom >= 1.5; rampFrom = Math.round((rampFrom - 0.25) * 100) / 100) {
    const planned = entryRamp(durationInFrames, rampFrom, rampFrames, baseSpeed);
    if (!planned) throw new Error(`The incoming shot is too short for a motion cut (it needs at least ${rampFrames + 8} frames).`);
    const sourceEndMs = Math.round(clip.sourceStartMs + onScreenMs * planned.speed);
    if (sourceDurationMs != null && sourceEndMs > sourceDurationMs) continue;
    return {
      ...clip,
      transitionIn: "motionCut",
      speed: planned.speed,
      sourceEndMs,
      ramp: planned.ramp,
      motionCut: { out: verdict.out, in: verdict.in, rampFrom, rampFrames, base: { speed: baseSpeed, ramp: prior ? prior.ramp : (clip.ramp ?? null) } },
    };
  }
  throw new Error("The incoming shot has too little footage after it for the speed-up a motion cut needs. Trim it to start earlier, or keep the hard cut.");
}

/**
 * The clip without its motion cut, entering by `transitionIn`: its earlier speed and ramp given back, its window shortened
 * to what that speed plays in the same time on screen (so nothing after it moves, even after a trim). Unchanged when it has none.
 */
export function withoutMotionCut(clip: Clip, transitionIn: Clip["transitionIn"] = "cut"): Clip {
  if (!clip.motionCut) return clip.transitionIn === "motionCut" ? { ...clip, transitionIn } : clip;
  const { base } = clip.motionCut;
  const onScreenMs = (clip.sourceEndMs - clip.sourceStartMs) / clip.speed;
  const next: Clip = { ...clip, transitionIn, speed: base.speed, sourceEndMs: Math.round(clip.sourceStartMs + onScreenMs * base.speed), ramp: base.ramp ?? null };
  delete next.motionCut;
  return next;
}

/** One frame's blur, in reel pixels at `width` wide: along an angle (degrees, screen space, 0 = horizontal) or radial about the centre. */
export type CutBlur = { kind: "directional"; angleDeg: number; sigmaPx: number } | { kind: "zoom"; spread: number; push: boolean };

/**
 * The blur a motion cut draws on one frame of one side: `frame` counts from the cut (0 is the first incoming frame;
 * for the outgoing side, 0 is its last frame, 1 the one before). Null on frames the cut does not touch.
 *
 * Sized from the picture's real speed: a frame moves `speed × width / fps` px, a 180° shutter blurs half of that, and a
 * Gaussian of sigma L/2.5 has about that length. The incoming side adds what the ramp's extra speed would have smeared
 * (the footage already carries its native 1× blur), plus one native blur on its first two frames, where the cut must hide;
 * the outgoing side adds half then one native blur on its last two frames.
 */
export function cutBlurAt(cut: Pick<MotionCut, "out" | "in" | "rampFrom" | "rampFrames">, side: "out" | "in", frame: number, fps: number, width: number): CutBlur | null {
  const v = side === "out" ? cut.out : cut.in;
  let extra: number;
  if (side === "out") {
    if (frame < 0 || frame >= MOTION_CUT.outFrames) return null;
    extra = frame === 0 ? 1 : 0.5;
  } else {
    if (frame < 0 || frame >= cut.rampFrames) return null;
    extra = entrySpeedAt(frame, cut.rampFrom, cut.rampFrames) - 1 + (frame < 2 ? 1 : 0);
  }
  if (extra <= 0.02) return null;
  const kind = vectorKind(v);
  if (kind === "lateral") {
    const pxPerFrame = (Math.hypot(v.dx, v.dy) * width) / fps;
    const sigmaPx = Math.min(MOTION_CUT.maxSigmaPx * (width / 1080), (MOTION_CUT.shutter * extra * pxPerFrame) / 2.5);
    if (sigmaPx < 0.5) return null;
    return { kind: "directional", angleDeg: Math.round(((Math.atan2(v.dy, v.dx) * 180) / Math.PI) * 10) / 10, sigmaPx: Math.round(sigmaPx * 10) / 10 };
  }
  const spread = Math.min(MOTION_CUT.maxZoomSpread, (MOTION_CUT.shutter * extra * Math.abs(v.zoom)) / fps);
  if (spread < 0.004) return null;
  return { kind: "zoom", spread: Math.round(spread * 1000) / 1000, push: kind === "push" };
}
