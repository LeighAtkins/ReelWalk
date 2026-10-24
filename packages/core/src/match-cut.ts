/**
 * Match cuts (ADR 0067): which shots cut well into which, from the measured
 * motion the editor already gathers (motion.ts, ADR 0034/0052) on small grey
 * frames. A cut reads as one movement when the camera's direction carries
 * across it (the outgoing shot pans left, the incoming shot is panning left)
 * and the eye does not have to jump (the moving subject sits in about the
 * same place on both sides).
 *
 * Pure: the browser or an ffmpeg script makes the frames; this only does
 * arithmetic, so it is tested on synthetic flows and reachable over HTTP.
 */
import { z } from "zod";
import { motionProfile, type Gray, type MotionSample } from "./motion";
import { motionReadSchema, sideReadOf, type MotionRead, type RampFootage } from "./motion-kind";
import { clipEnergyFromMotion } from "./pacing";
import type { Clip, Timeline } from "./timeline";

export type WhipDirection = NonNullable<Clip["whipDirection"]>;

/** Image velocity at the analysis size (48 px wide), px/s: dx > 0 is content moving right, dy > 0 moving down. */
export const motionVectorSchema = z.object({ dx: z.number(), dy: z.number() });
export type MotionVector = z.infer<typeof motionVectorSchema>;

export const clipMotionSchema = z.object({
  /** Camera motion over the first half of the sampled frames. */
  start: motionVectorSchema,
  /** Camera motion over the last half: what the cut leaves on. */
  end: motionVectorSchema,
  /** Where the moving thing is in the frame (fractions), or null when nothing moves against the camera. */
  subject: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable(),
  /** How much the shot moves, 0..1 (`clipEnergyFromMotion`). */
  energy: z.number().min(0).max(1),
  /**
   * What the camera is doing over the clip's first and last half second (ADR 0074): pan, tilt, push in, pull out,
   * roll or nothing, found by fitting a flow to the whole frame, so slow footage and forward moves read as what they
   * are. Optional: a motion measured the older way has only `start` and `end`.
   */
  startRead: motionReadSchema.optional(),
  endRead: motionReadSchema.optional(),
});
export type ClipMotion = z.infer<typeof clipMotionSchema>;

/** Motion by clip id (or by asset id for library media not yet in the reel). */
export const clipMotionMapSchema = z.record(z.string().min(1), clipMotionSchema);

/** Slower than this (px/s at 48 px wide, a tenth of the frame a second) the camera reads as still. */
export const STILL_PX_PER_S = 5;
/** Speed at which direction counts fully. */
const FULL_PX_PER_S = 14;

function meanVelocity(samples: readonly MotionSample[]): MotionVector {
  if (samples.length === 0) return { dx: 0, dy: 0 };
  let dx = 0, dy = 0;
  for (const sample of samples) {
    const seconds = Math.max(0.04, (sample.t2 - sample.t) / 1000);
    dx += sample.dx / seconds;
    dy += sample.dy / seconds;
  }
  return { dx: round2(dx / samples.length), dy: round2(dy / samples.length) };
}

/**
 * The centroid of what moved against the camera between two frames, as frame
 * fractions: `b` is compared with `a` shifted by the camera's own (dx, dy), so
 * a pan over a still room has no subject, and a person walking through it
 * does. Null when almost nothing moved.
 */
export function movingCentroid(a: Gray, b: Gray, dx = 0, dy = 0, threshold = 18): { x: number; y: number } | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  let sum = 0, sx = 0, sy = 0, seen = 0;
  for (let y = Math.max(0, dy); y < Math.min(b.height, b.height + dy); y++) for (let x = Math.max(0, dx); x < Math.min(b.width, b.width + dx); x++) {
    const d = Math.abs(a.data[(y - dy) * a.width + (x - dx)] - b.data[y * b.width + x]);
    seen++;
    if (d < threshold) continue;
    sum += d; sx += d * (x + 0.5); sy += d * (y + 0.5);
  }
  // Fewer than about two percent of the pixels changing is noise, not a subject.
  if (seen === 0 || sum < threshold * seen * 0.02) return null;
  return { x: round2(sx / sum / b.width), y: round2(sy / sum / b.height) };
}

/** A clip's motion from frames sampled across it (at least two). Null with too few frames. */
export function summariseMotion(frames: readonly { t: number; gray: Gray }[]): ClipMotion | null {
  if (frames.length < 2) return null;
  const samples = motionProfile([...frames]);
  const half = Math.ceil(samples.length / 2);
  const last = frames[frames.length - 1], before = frames[frames.length - 2];
  const shift = samples[samples.length - 1];
  return {
    start: meanVelocity(samples.slice(0, half)),
    end: meanVelocity(samples.slice(samples.length - half)),
    subject: movingCentroid(before.gray, last.gray, shift.dx, shift.dy),
    energy: clipEnergyFromMotion(samples) ?? 0,
  };
}

/**
 * A clip's motion with the camera readings of its first and last half second attached (ADR 0074). The older `start` and
 * `end` vectors are replaced by the readings' pans (px/s at 48 px wide), so whip directions and match scores see a slow
 * pan the whole-pixel block matching missed; a reading that is not a pan leaves them at zero.
 */
export function withReads(motion: ClipMotion, head: MotionRead | null, tail: MotionRead | null): ClipMotion {
  const pan = (read: MotionRead): MotionVector => (read.kind === "pan-x" || read.kind === "pan-y" ? { dx: round2(read.tx * ANALYSIS_PX), dy: round2(read.ty * ANALYSIS_PX) } : { dx: 0, dy: 0 });
  return { ...motion, ...(head ? { start: pan(head), startRead: head } : {}), ...(tail ? { end: pan(tail), endRead: tail } : {}) };
}

export function motionSpeed(v: MotionVector): number {
  return Math.hypot(v.dx, v.dy);
}

/** The analysis width, px: a reading's frame widths a second are this many px a second in the older vectors. */
export const ANALYSIS_PX = 48;

/** The direction content travels, or null when the camera is as good as still (`still`: px/s at 48 px wide, 0 for a vector from a reading that has already decided). */
export function motionDirection(v: MotionVector, still: number = STILL_PX_PER_S): WhipDirection | null {
  if (motionSpeed(v) < still || motionSpeed(v) === 0) return null;
  if (Math.abs(v.dx) >= Math.abs(v.dy)) return v.dx > 0 ? "right" : "left";
  return v.dy > 0 ? "down" : "up";
}

/**
 * The whip for a cut out of `outgoing`: a whip's direction names the camera
 * pan, and content travels the other way, so content leaving to the left is a
 * camera panning right. Null when the shot does not move enough to whip from.
 */
export function whipDirectionFor(outgoing: ClipMotion): WhipDirection | null {
  // A reading says whether the shot pans at all, however slowly; a push or a roll has no pan to whip along.
  if (outgoing.endRead && outgoing.endRead.kind !== "pan-x" && outgoing.endRead.kind !== "pan-y") return null;
  const content = outgoing.endRead ? motionDirection({ dx: outgoing.endRead.tx * ANALYSIS_PX, dy: outgoing.endRead.ty * ANALYSIS_PX }, 0) : motionDirection(outgoing.end);
  if (!content) return null;
  return ({ left: "right", right: "left", up: "down", down: "up" } as const)[content];
}

/**
 * How well `a` cuts into `b`, −1..1: the cosine between a's final and b's
 * opening motion, weighted by how much both move (a still shot has no
 * direction to carry), plus a little for the subject sitting in the same
 * place. 0 is "nothing speaks for or against it".
 */
export function matchCutScore(a: ClipMotion, b: ClipMotion): number {
  let direction = 0;
  const ra = a.endRead, rb = b.startRead;
  const zooms = (read: MotionRead | undefined) => read?.kind === "zoom-in" || read?.kind === "zoom-out";
  if (ra && rb && (zooms(ra) || zooms(rb))) {
    // A push carries into a push, and a push into a pull stops dead; a push against a pan says nothing, against a held shot a little against.
    if (zooms(ra) && zooms(rb)) direction = (Math.sign(ra.zoom) === Math.sign(rb.zoom) ? 1 : -1) * Math.min(1, Math.min(ra.speed, rb.speed) / 0.15);
    else if (ra.kind === "still" || rb.kind === "still") direction = -0.25 * Math.min(1, Math.max(ra.speed, rb.speed) / 0.15);
  } else {
    // With a reading on both sides, a pan counts however slow (a tenth of a frame width a second counts fully); the older vectors keep their thresholds.
    const read = Boolean(ra && rb);
    const still = read ? 0 : STILL_PX_PER_S, full = read ? 0.1 * ANALYSIS_PX : FULL_PX_PER_S;
    const pan = (r: MotionRead): MotionVector => (r.kind === "pan-x" || r.kind === "pan-y" ? { dx: r.tx * ANALYSIS_PX, dy: r.ty * ANALYSIS_PX } : { dx: 0, dy: 0 });
    const va = read ? pan(ra!) : a.end, vb = read ? pan(rb!) : b.start;
    const sa = motionSpeed(va), sb = motionSpeed(vb);
    const moves = (speed: number) => speed > 0 && speed >= still;
    if (moves(sa) && moves(sb)) {
      const cosine = (va.dx * vb.dx + va.dy * vb.dy) / (sa * sb);
      direction = cosine * Math.min(1, Math.min(sa, sb) / full);
    } else if (moves(sa) || moves(sb)) {
      // One side moves, the other is still: the motion stops dead at the cut, the more so the faster it was.
      direction = -0.25 * Math.min(1, Math.max(sa, sb) / full);
    }
  }
  let subject = 0;
  if (a.subject && b.subject) subject = Math.max(0, 1 - Math.hypot(a.subject.x - b.subject.x, a.subject.y - b.subject.y) / 0.5) * 2 - 1;
  const score = 0.7 * direction + 0.3 * (a.subject && b.subject ? subject : 0);
  return Math.max(-1, Math.min(1, round2(score)));
}

export type MatchCut = { fromId: string; toId: string; score: number; whip: WhipDirection | null };
export type MatchCutSuggestions = {
  /** For each speed-ramp cut with a reading on either side, what each side was doing (ADR 0074). */
  footage: { clipId: string; footage: RampFootage }[];
  /** Pairs that cut well, best first, measured clips only. */
  pairs: MatchCut[];
  /** The clips reordered so each cut carries motion when one can: a greedy chain from the current opening shot. */
  order: string[];
  /** Pairs already adjacent in the reel whose whip direction should follow the footage. */
  whips: { clipId: string; direction: WhipDirection }[];
};

export type MatchCutOptions = {
  /** Lowest score that counts as cutting well. */
  minScore?: number;
  /** Clips that must keep their place (a presenter take, a clip with speech). */
  heldClipIds?: readonly string[];
};

/**
 * Suggestions for a reel from its clips' measured motion. Clips without a
 * measurement take no part in `pairs` and keep their place in `order`.
 */
export function suggestMatchCuts(timeline: Timeline, motion: Record<string, ClipMotion>, { minScore = 0.35, heldClipIds = [] }: MatchCutOptions = {}): MatchCutSuggestions {
  const clips = timeline.clips;
  const held = new Set(heldClipIds);
  const measured = clips.filter((clip) => motion[clip.id]);
  const pairs: MatchCut[] = [];
  for (const a of measured) for (const b of measured) {
    if (a.id === b.id) continue;
    const score = matchCutScore(motion[a.id], motion[b.id]);
    if (score >= minScore) pairs.push({ fromId: a.id, toId: b.id, score, whip: whipDirectionFor(motion[a.id]) });
  }
  pairs.sort((p, q) => q.score - p.score || clips.findIndex((c) => c.id === p.fromId) - clips.findIndex((c) => c.id === q.fromId));

  // Greedy chain: from the opening shot, the best unused match each time; held clips stay in their slots.
  const order: string[] = [];
  const used = new Set<string>();
  const slots = clips.map((clip) => (held.has(clip.id) ? clip.id : null));
  const free = clips.filter((clip) => !held.has(clip.id));
  let current: Clip | null = null;
  for (let index = 0; index < clips.length; index++) {
    const fixed = slots[index];
    if (fixed) { order.push(fixed); used.add(fixed); current = clips.find((clip) => clip.id === fixed) ?? null; continue; }
    let pick: Clip | null = null;
    if (current && motion[current.id]) {
      let best = minScore - 1e-9;
      for (const candidate of free) {
        if (used.has(candidate.id) || !motion[candidate.id]) continue;
        const score = matchCutScore(motion[current.id], motion[candidate.id]);
        if (score > best) { best = score; pick = candidate; }
      }
    }
    if (!pick) pick = free.find((clip) => !used.has(clip.id)) ?? null;
    if (!pick) break;
    order.push(pick.id); used.add(pick.id); current = pick;
  }

  const whips: MatchCutSuggestions["whips"] = [];
  clips.forEach((clip, index) => {
    if (index === 0 || (clip.transitionIn !== "whip" && clip.transitionIn !== "speedRamp")) return;
    const outgoing = motion[clips[index - 1].id];
    const direction = outgoing ? whipDirectionFor(outgoing) : null;
    if (direction && direction !== clip.whipDirection) whips.push({ clipId: clip.id, direction });
  });
  const footage: MatchCutSuggestions["footage"] = [];
  clips.forEach((clip, index) => {
    if (index === 0 || clip.transitionIn !== "speedRamp") return;
    const outgoing = motion[clips[index - 1].id]?.endRead, incoming = motion[clip.id]?.startRead;
    if (!outgoing && !incoming) return;
    footage.push({ clipId: clip.id, footage: { after: clips[index - 1].id, ...(outgoing ? { out: sideReadOf(outgoing) } : {}), ...(incoming ? { in: sideReadOf(incoming) } : {}) } });
  });
  return { pairs, order, whips, footage };
}

/** For the Add media flow: after which shots in the reel a candidate (by its motion) cuts well, best first. */
export function cutsWellAfter(timeline: Timeline, motion: Record<string, ClipMotion>, candidate: ClipMotion, minScore = 0.35): { clipId: string; index: number; score: number }[] {
  return timeline.clips
    .map((clip, index) => ({ clipId: clip.id, index, score: motion[clip.id] ? matchCutScore(motion[clip.id], candidate) : -1 }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

const round2 = (value: number) => Math.round(value * 100) / 100;
