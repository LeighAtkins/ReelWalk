/**
 * The speed-ramp transition (ADR 0073): a cut between two clips that
 * accelerates the outgoing clip into the cut and lets the incoming clip
 * decelerate out of it. The outgoing clip's last `durationMs / 2` runs from
 * 1× up to `peak`×, the cut lands on the peak, and the incoming clip starts at
 * `peak`× and settles to 1× over its first `durationMs / 2`; a directional
 * blur and a small push-in follow the speed.
 *
 * Pure maths, no DOM, so the composition (preview and export), the editor and
 * the commands read one function. Nothing here changes the timeline's length:
 * a clip still takes `durationInFrames`, only *which* source frame it shows on
 * each of them changes (`ClipSpeedPlan.position`), through the same frame
 * maths as ramps (frames.ts).
 *
 * The source-handle rule. At `peak`× the outgoing tail reads more source than
 * it takes screen time, and the incoming head, if it starts at the in-point at
 * speed, runs ahead of where the clip would otherwise be. Whatever extra
 * source a clip would need is found by simulating its frames, and met in this
 * order, each step only when the one before is not enough:
 *   1. "handles"     the clip's own source beyond its out-point (known from
 *                    the asset's length) covers it; the incoming head reads
 *                    its pre-roll before the in-point when there is some
 *                    (never for speech, so a trimmed word cannot show).
 *   2. "compensated" the shortfall is made up by playing the body of the clip
 *                    slightly slower (a smooth dip, at most 40 % slower), so
 *                    the clip still ends on the source frame it always did.
 *   3. "reduced"     the peak is lowered until that is enough (not below
 *                    1.5×), the slow-down held to 25 % so the two give a
 *                    little each; reported with the peak that was used.
 *   4. "none"        a plain cut; reported as such.
 * Both sides of a cut use the same peak, so the speed at the cut is
 * continuous. No frame ever repeats: every frame advances the source by at
 * least 0.6 of the clip's own rate.
 */
import { rampGain, rampSpeedAt } from "./ramp";
import { defaultSpeedRamp, speedRampSchema, type SpeedRampDirection, type SpeedRampParams } from "./speed-ramp-params";
import { clipSourceFrame, msToFrame } from "./frames";
import { REEL_FORMAT, type Clip } from "./timeline";

const round2 = (value: number) => Math.round(value * 100) / 100;

// ── Curves ──────────────────────────────────────────────────────

/** Never less than this many frames each side (a tail or head shorter than that is not a ramp). */
export const SPEED_RAMP_MIN_FRAMES = 2;
/** A clip gives at most this share of its length to one side, so the head and the tail never meet. */
const SIDE_SHARE = 0.4;
/** The body of a clip plays at most this much slower to make up source (a floor of 0.6× its own rate). */
export const SPEED_RAMP_MAX_DIP = 0.4;
/** When the peak is being lowered too, the slow-down is held to this (a floor of 0.75×): the two give a little each. */
export const SPEED_RAMP_REDUCED_DIP = 0.25;
/** The lowest peak a reduced ramp may fall to before it is a plain cut. */
export const SPEED_RAMP_MIN_PEAK = 1.5;
/** A media element cannot be asked for more than this rate. */
const MAX_MEDIA_RATE = 16;
/** The widest blur (σ, px at 1080 wide) at `blur` 1 and the peak; scaled by the strength setting. */
export const SPEED_RAMP_BLUR_PX = 56;

/** Frames each side takes: half the duration, rounded, at least two. */
export function speedRampHalfFrames(params: Pick<SpeedRampParams, "durationMs">, fps: number = REEL_FORMAT.fps): number {
  return Math.max(SPEED_RAMP_MIN_FRAMES, Math.round((params.durationMs / 2 * fps) / 1000));
}

/**
 * How far into the ramp the k-th of `frames` frames is, 0..1, easing in so the
 * speed builds slowly and the last frame is the peak: (k + 1)² / frames². The
 * incoming head is this curve run backwards (its first frame is the peak).
 */
export function speedRampIntensityAt(k: number, frames: number): number {
  const t = Math.min(1, Math.max(0, (k + 1) / Math.max(1, frames)));
  return t * t;
}

/** The speed multiple at intensity `i` for a peak: 1 at 0, `peak` at 1. */
export const speedRampRate = (i: number, peak: number) => 1 + (peak - 1) * i;

// ── Per-clip plan ───────────────────────────────────────────────

export type SideMode = "none" | "exact" | "handles" | "compensated" | "reduced";
export type HeadStart = "none" | "preroll" | "partial" | "in-point";

export type SideReport = {
  /** Frames of the ramp on this side (0 when there is none). */
  frames: number;
  /** How the source for the ramp was found; see the module comment. */
  mode: SideMode;
  /** The peak this side could run (the requested one, or lower for "reduced"). */
  peak: number;
};

/** What was done for one speed-ramp cut, for the sheet, the export notes and the tests. */
export type SpeedRampCutReport = {
  /** The incoming clip: the one whose `transitionIn` is "speedRamp". */
  clipId: string;
  /** Position of the incoming clip in the reel. */
  index: number;
  requestedPeak: number;
  /** The peak both sides ran: continuous through the cut. */
  peak: number;
  /** The outgoing tail's fallback. */
  out: SideReport;
  /** The incoming head's fallback, and how it started. */
  in: SideReport & { start: HeadStart };
  /** True when a plain cut was kept instead (nothing here moves). */
  skipped: boolean;
  /** One line for people. */
  note: string;
};

export type ClipSpeedPlan = {
  clipId: string;
  frames: number;
  /**
   * The clip's own frame (fractional) shown on each of its `frames` frames, in
   * the units `clipSourceFrame` takes: equal to the frame number for a clip
   * with no speed ramp; negative for a head that reads its pre-roll; past
   * `frames` for a tail that reads beyond its out-point.
   */
  position: number[];
  /** The speed multiple on each frame (1 outside the ramps). */
  rate: number[];
  /** Blur σ in px at 1080 wide, per frame. */
  blurX: number[];
  blurY: number[];
  /** Scale added to the picture, per frame (0 = none). */
  push: number[];
};

export type ClipRampSide = {
  frames: number;
  peak: number;
  blur: number;
  push: number;
  /** The blur axis as unit-ish weights (1,0) horizontal, (0,1) vertical. */
  axis: { x: number; y: number };
};

type ClipLike = Pick<Clip, "kind" | "speed" | "sourceStartMs" | "ramp">;

/** The source frame at clip-frame `u`, continuing a ramped clip's curve linearly past its two ends. */
export function sourceFrameAt(clip: ClipLike, u: number, frames: number, fps: number = REEL_FORMAT.fps): number {
  if (u >= 0 && u <= frames) return clipSourceFrame(clip, u, frames, fps);
  const speed = clip.kind === "IMAGE" ? 1 : clip.speed || 1;
  const ramp = clip.kind === "IMAGE" ? null : clip.ramp;
  if (u < 0) return msToFrame(clip.sourceStartMs, fps) + u * speed * (ramp ? rampSpeedAt(ramp, 0) : 1);
  return clipSourceFrame(clip, frames, frames, fps) + (u - frames) * speed * (ramp ? rampSpeedAt(ramp, 1) : 1);
}

type Shape = { head: ClipRampSide | null; tail: ClipRampSide | null };

/** The multiplier of each frame from the two ramps, and the intensity of each. */
function curves(frames: number, shape: Shape): { rate: number[]; intensity: number[] } {
  const rate = new Array<number>(frames).fill(1);
  const intensity = new Array<number>(frames).fill(0);
  const { head, tail } = shape;
  if (head) {
    for (let j = 0; j < head.frames && j < frames; j++) {
      const i = speedRampIntensityAt(head.frames - 1 - j, head.frames);
      rate[j] *= speedRampRate(i, head.peak);
      intensity[j] = Math.max(intensity[j], i);
    }
  }
  if (tail) {
    for (let k = 0; k < tail.frames; k++) {
      const f = frames - tail.frames + k;
      if (f < 0) continue;
      const i = speedRampIntensityAt(k, tail.frames);
      rate[f] *= speedRampRate(i, tail.peak);
      intensity[f] = Math.max(intensity[f], i);
    }
  }
  return { rate, intensity };
}

/** The multiplier (<= 1) of the body between the two ramps for a dip of depth `d`: a smooth bump, zero at both ends. */
function dipCurve(frames: number, shape: Shape, d: number): number[] {
  const out = new Array<number>(frames).fill(1);
  if (d <= 0) return out;
  const from = shape.head?.frames ?? 0;
  const to = frames - (shape.tail?.frames ?? 0);
  const body = to - from;
  if (body < 3) return out;
  for (let f = from; f < to; f++) {
    const s = Math.sin((Math.PI * (f - from + 0.5)) / body);
    out[f] = 1 - d * s * s;
  }
  return out;
}

type Simulated = { position: number[]; rate: number[]; intensity: number[]; end: number; start: number; last: number; maxRate: number };

/** Plays the clip's frames: the clip-frame shown on every frame and the one after the last (`end`); `start` and `last` are source frames of the first and last shown. */
function simulate(clip: ClipLike, frames: number, shape: Shape, d: number, preroll: number, fps: number): Simulated {
  const { rate: ramps, intensity } = curves(frames, shape);
  const dip = dipCurve(frames, shape, d);
  const rate = ramps.map((value, f) => value * dip[f]);
  const position = new Array<number>(frames);
  let u = preroll > 0 ? -preroll : 0;
  for (let f = 0; f < frames; f++) {
    position[f] = u;
    u += rate[f];
  }
  const start = sourceFrameAt(clip, position[0], frames, fps);
  const last = sourceFrameAt(clip, position[frames - 1], frames, fps);
  // The media element is asked for the mean rate since the first frame; its largest value must stay playable.
  let maxRate = 0;
  for (let f = 1; f < frames; f++) maxRate = Math.max(maxRate, (sourceFrameAt(clip, position[f], frames, fps) - start) / f);
  return { position, rate, intensity, end: u, start, last, maxRate };
}

export type ClipPlanInput = {
  clip: ClipLike & Pick<Clip, "id">;
  frames: number;
  head: ClipRampSide | null;
  tail: ClipRampSide | null;
  /** The source's length in frames when known; unknown means no source beyond the out-point is assumed. */
  sourceFrames: number | null;
  /** Speech in the clip: its head never reads before the in-point, so a trimmed word cannot show. */
  speech?: boolean;
  /** Which side's peak may be lowered to make it fit; the other is held (it belongs to a cut already settled). Both by default. */
  scalable?: "head" | "tail" | "both";
  fps?: number;
};

export type ClipPlanResult = {
  plan: ClipSpeedPlan;
  head: SideReport & { start: HeadStart };
  tail: SideReport;
  /** Depth of the slow-down before the ramp (0 = none; 0.2 plays that stretch at 0.8×). */
  dip: number;
};

const NO_SIDE: SideReport = { frames: 0, mode: "none", peak: 1 };

/**
 * One clip's frames with its head and tail ramps, the fallback found by
 * simulation (see the module comment). Returns the plan and what was done on
 * each side. With neither side it is the identity.
 */
export function planClipSpeed(input: ClipPlanInput): ClipPlanResult {
  const { clip, frames } = input;
  const fps = input.fps ?? REEL_FORMAT.fps;
  const scalable = input.scalable ?? "both";
  const cap = Math.max(0, Math.floor(frames * SIDE_SHARE));
  const usable = (side: ClipRampSide | null) => (side && side.peak > 1 && side.frames >= SPEED_RAMP_MIN_FRAMES && cap >= SPEED_RAMP_MIN_FRAMES ? { ...side, frames: Math.min(side.frames, cap) } : null);
  const head = usable(input.head);
  const tail = usable(input.tail);
  const identity = (): ClipPlanResult => ({ plan: identityPlan(clip.id, frames), head: { ...NO_SIDE, start: "none" }, tail: NO_SIDE, dip: 0 });
  if (!head && !tail) return identity();

  const shapeAt = (scale: number): Shape => ({
    head: head ? { ...head, peak: scalable === "tail" ? head.peak : scalePeak(head.peak, scale) } : null,
    tail: tail ? { ...tail, peak: scalable === "head" ? tail.peak : scalePeak(tail.peak, scale) } : null,
  });

  // Photos have no source to read: the ramp is only the blur and the push.
  if (clip.kind === "IMAGE") {
    const shape = shapeAt(1);
    return {
      plan: toPlan(clip.id, frames, shape, simulate(clip, frames, shape, 0, 0, fps)),
      head: head ? { frames: head.frames, mode: "exact", peak: head.peak, start: "none" } : { ...NO_SIDE, start: "none" },
      tail: tail ? { frames: tail.frames, mode: "exact", peak: tail.peak } : NO_SIDE,
      dip: 0,
    };
  }

  const speed = clip.speed || 1;
  const nominalLast = clipSourceFrame(clip, frames - 1, frames, fps);
  const limitLast = input.sourceFrames !== null ? Math.max(nominalLast, input.sourceFrames - 1) : nominalLast;
  const startRate = speed * (clip.ramp ? rampSpeedAt(clip.ramp, 0) : 1);
  const clipFramesBefore = startRate > 0 ? msToFrame(clip.sourceStartMs, fps) / startRate : 0;
  const fits = (sim: Simulated) => sim.last <= limitLast + 1e-6 && sim.start >= -1e-6 && sim.maxRate <= MAX_MEDIA_RATE;
  const extraOf = (side: ClipRampSide | null) => (side ? curves(frames, { head: side, tail: null }).rate.reduce((sum, value) => sum + (value - 1), 0) : 0);

  type Solved = { scale: number; d: number; preroll: number; shape: Shape; sim: Simulated };
  const solve = (scale: number, maxDip: number = SPEED_RAMP_MAX_DIP): Solved | null => {
    const shape = shapeAt(scale);
    // Pre-roll: read the head's extra source before the in-point, as far as there is any (never under speech).
    const preroll = shape.head && !input.speech ? Math.min(extraOf(shape.head), clipFramesBefore) : 0;
    const at = (d: number) => simulate(clip, frames, shape, d, preroll, fps);
    const plain = at(0);
    if (fits(plain)) return { scale, d: 0, preroll, shape, sim: plain };
    if (!fits(at(maxDip))) return null;
    let lo = 0, hi = maxDip;
    for (let step = 0; step < 24; step++) {
      const mid = (lo + hi) / 2;
      if (fits(at(mid))) hi = mid; else lo = mid;
    }
    return { scale, d: hi, preroll, shape, sim: at(hi) };
  };

  let solved = solve(1);
  let reduced = false;
  if (!solved) {
    // Lower the scalable peak(s) as little as will fit, never below SPEED_RAMP_MIN_PEAK.
    const top = scalable === "tail" ? tail?.peak ?? 1 : scalable === "head" ? head?.peak ?? 1 : Math.max(head?.peak ?? 1, tail?.peak ?? 1);
    const floor = Math.min(1, (SPEED_RAMP_MIN_PEAK - 1) / Math.max(1e-6, top - 1));
    if (top > 1 && solve(floor, SPEED_RAMP_REDUCED_DIP)) {
      let lo = floor, hi = 1;
      for (let step = 0; step < 24; step++) {
        const mid = (lo + hi) / 2;
        if (solve(mid, SPEED_RAMP_REDUCED_DIP)) lo = mid; else hi = mid;
      }
      solved = solve(lo, SPEED_RAMP_REDUCED_DIP);
      reduced = true;
    }
  }
  if (!solved) {
    // Not even at the lowest peak: drop the side that could give way, keep a held one (it was settled alone).
    if (scalable === "tail" && head) return planClipSpeed({ ...input, tail: null });
    if (scalable === "head" && tail) return planClipSpeed({ ...input, head: null });
    return identity();
  }

  const { d, preroll, shape, sim } = solved;
  const mode: SideMode = reduced ? "reduced" : d > 1e-6 ? "compensated" : sim.end - frames > 0.5 ? "handles" : "exact";
  const full = shape.head ? extraOf(shape.head) : 0;
  const start: HeadStart = !shape.head ? "none" : preroll <= 1e-6 ? "in-point" : preroll >= full - 1e-6 ? "preroll" : "partial";
  return {
    plan: toPlan(clip.id, frames, shape, sim),
    head: shape.head ? { frames: shape.head.frames, mode, peak: shape.head.peak, start } : { ...NO_SIDE, start: "none" },
    tail: shape.tail ? { frames: shape.tail.frames, mode, peak: shape.tail.peak } : NO_SIDE,
    dip: d,
  };
}

const scalePeak = (peak: number, scale: number) => 1 + (peak - 1) * scale;

function identityPlan(clipId: string, frames: number): ClipSpeedPlan {
  return { clipId, frames, position: Array.from({ length: frames }, (_, f) => f), rate: new Array(frames).fill(1), blurX: new Array(frames).fill(0), blurY: new Array(frames).fill(0), push: new Array(frames).fill(0) };
}

function toPlan(clipId: string, frames: number, shape: Shape, sim: Simulated): ClipSpeedPlan {
  const blurX = new Array<number>(frames).fill(0);
  const blurY = new Array<number>(frames).fill(0);
  const push = new Array<number>(frames).fill(0);
  const { head, tail } = shape;
  const apply = (side: ClipRampSide, f: number, i: number) => {
    const sigma = side.blur * i * SPEED_RAMP_BLUR_PX;
    blurX[f] = Math.max(blurX[f], sigma * side.axis.x);
    blurY[f] = Math.max(blurY[f], sigma * side.axis.y);
    push[f] = Math.max(push[f], side.push * i);
  };
  if (head) for (let j = 0; j < head.frames && j < frames; j++) apply(head, j, speedRampIntensityAt(head.frames - 1 - j, head.frames));
  if (tail) for (let k = 0; k < tail.frames; k++) if (frames - tail.frames + k >= 0) apply(tail, frames - tail.frames + k, speedRampIntensityAt(k, tail.frames));
  return { clipId, frames, position: sim.position, rate: sim.rate, blurX, blurY, push };
}

// ── Direction ───────────────────────────────────────────────────

/** The blur axis weights for a direction: horizontal (1, 0), vertical (0, 1), an angle's components, none (0, 0). "auto" is read from the footage's whip direction, right when there is none. */
export function blurAxis(direction: SpeedRampDirection, whipDirection?: Clip["whipDirection"]): { x: number; y: number } {
  const named = direction === "auto" ? whipDirection ?? "right" : direction;
  if (typeof named === "number") {
    const radians = (named * Math.PI) / 180;
    return { x: round3(Math.abs(Math.cos(radians))), y: round3(Math.abs(Math.sin(radians))) };
  }
  switch (named) {
    case "left":
    case "right":
      return { x: 1, y: 0 };
    case "up":
    case "down":
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: 0 };
  }
}
const round3 = (value: number) => Math.round(value * 1000) / 1000;

// ── The reel's plan ─────────────────────────────────────────────

export type ReelClipInput = {
  clip: Clip;
  /** The clip's frames in the reel (`framePlan`). */
  durationInFrames: number;
  /** The clip's source length in ms when the asset's is known. */
  sourceDurationMs?: number | null;
  /** The clip's asset carries speech (a transcript): its head does not read before the in-point. */
  speech?: boolean;
};

export type SpeedRampReelPlan = {
  /** Plans by clip id, only for clips a speed-ramp cut touches. */
  clips: Map<string, ClipSpeedPlan>;
  cuts: SpeedRampCutReport[];
};

/** True when the clip comes in on a speed-ramp cut. */
export const hasSpeedRampIn = (clip: Pick<Clip, "transitionIn">, index: number) => index > 0 && clip.transitionIn === "speedRamp";

/** The clip's parameters (stored, with defaults filled in, or invalid ones replaced by the defaults). */
export function speedRampOf(clip: Pick<Clip, "speedRamp">): SpeedRampParams {
  const parsed = speedRampSchema.safeParse(clip.speedRamp ?? {});
  return parsed.success ? parsed.data : defaultSpeedRamp();
}

const sideOf = (params: SpeedRampParams, peak: number, whipDirection: Clip["whipDirection"], fps: number): ClipRampSide => ({
  frames: speedRampHalfFrames(params, fps),
  peak,
  blur: params.blur,
  push: params.push,
  axis: blurAxis(params.direction, whipDirection),
});

/**
 * Every speed-ramp cut of a reel planned: the plan of each clip it touches and
 * a report per cut. The peak of a cut is the lower of what the two clips can
 * play, found in order from the first cut (a clip's head is fixed before its
 * tail is asked, and a later cut is assumed to run its full peak, which only
 * ever asks the earlier one for more source than it will use).
 */
export function planSpeedRamps(inputs: readonly ReelClipInput[], fps: number = REEL_FORMAT.fps): SpeedRampReelPlan {
  const cutAt = inputs.map((entry, index) => (hasSpeedRampIn(entry.clip, index) ? speedRampOf(entry.clip) : null));
  const peaks = cutAt.map((params) => params?.peak ?? 0);
  const sourceFramesOf = (entry: ReelClipInput) => (entry.sourceDurationMs != null && entry.clip.kind === "VIDEO" ? msToFrame(entry.sourceDurationMs, fps) : null);

  /** One clip planned at the peaks now settled; `scalable` names the side still being asked for, `tail: false` leaves the tail out. */
  const planOf = (index: number, peaksNow: readonly number[], scalable: "head" | "tail", withTail = true): ClipPlanResult => {
    const entry = inputs[index];
    const into = cutAt[index];
    const out = withTail ? cutAt[index + 1] : null;
    return planClipSpeed({
      clip: entry.clip,
      frames: entry.durationInFrames,
      head: into && peaksNow[index] > 1 ? sideOf(into, peaksNow[index], entry.clip.whipDirection, fps) : null,
      tail: out && peaksNow[index + 1] > 1 ? sideOf(out, peaksNow[index + 1], inputs[index + 1].clip.whipDirection, fps) : null,
      sourceFrames: sourceFramesOf(entry),
      speech: entry.speech,
      scalable,
      fps,
    });
  };

  // Settle each cut's peak in order: the outgoing clip's tail (its head already settled, so held), then the incoming
  // clip's head on its own (its tail is settled at the next cut, where this head is held).
  for (let index = 1; index < inputs.length; index++) {
    const params = cutAt[index];
    if (!params) continue;
    const asked = peaks.map((peak, i) => (i === index ? params.peak : peak));
    const outgoing = planOf(index - 1, asked, "tail").tail;
    let settled = outgoing.mode === "none" ? 1 : Math.min(params.peak, outgoing.peak);
    if (settled > 1) {
      const incoming = planOf(index, asked.map((peak, i) => (i === index ? settled : peak)), "head", false).head;
      settled = incoming.mode === "none" ? 1 : Math.min(settled, incoming.peak);
    }
    peaks[index] = settled;
  }

  const clips = new Map<string, ClipSpeedPlan>();
  const results = inputs.map((_, index) => (cutAt[index] || cutAt[index + 1] ? planOf(index, peaks, "tail") : null));
  results.forEach((result, index) => {
    if (result) clips.set(inputs[index].clip.id, result.plan);
  });
  const reports: SpeedRampCutReport[] = [];
  for (let index = 1; index < inputs.length; index++) {
    const params = cutAt[index];
    if (!params) continue;
    const skipped = peaks[index] <= 1;
    const lowered = !skipped && peaks[index] < params.peak - 1e-6;
    // A lowered peak is reported as such on both sides (the dip may also be used, see `dip`).
    const outgoing = skipped ? NO_SIDE : { ...results[index - 1]!.tail, ...(lowered ? { mode: "reduced" as const } : {}) };
    const incoming = skipped ? { ...NO_SIDE, start: "none" as const } : { ...results[index]!.head, ...(lowered ? { mode: "reduced" as const } : {}) };
    reports.push({
      clipId: inputs[index].clip.id,
      index,
      requestedPeak: params.peak,
      peak: skipped ? 1 : peaks[index],
      out: outgoing,
      in: incoming,
      skipped,
      note: cutNote(index, params.peak, peaks[index], outgoing, incoming, skipped),
    });
  }
  return { clips, cuts: reports };
}

function cutNote(index: number, requested: number, peak: number, out: SideReport, incoming: SideReport & { start: HeadStart }, skipped: boolean): string {
  if (skipped) return `Cut ${index}: kept as a plain cut (the clips are too short or too close to their source's ends to ramp).`;
  const parts = [`Cut ${index}: speed ramp to ${round2(peak)}×${peak < requested - 0.005 ? ` (asked for ${round2(requested)}×)` : ""}`];
  const word: Record<SideMode, string> = { none: "no ramp", exact: "as it is", handles: "from the source beyond its end", compensated: "slowing slightly before the ramp", reduced: "at a lower peak" };
  parts.push(`outgoing ${word[out.mode]}`);
  parts.push(`incoming ${word[incoming.mode]}${incoming.start === "preroll" ? ", reading its lead-in" : incoming.start === "in-point" ? ", from its in-point" : ""}`);
  return `${parts[0]}; ${parts.slice(1).join(", ")}.`;
}

/** A clip with its speed-ramp plan attached by the composition (runtime only, never saved): what every reader of the clip's frames takes its source frame from. */
export type PlannedClip = Clip & { speedPlan?: ClipSpeedPlan };

/** The plan a clip carries, if any. */
export const speedPlanOf = (clip: Clip): ClipSpeedPlan | undefined => (clip as PlannedClip).speedPlan;

/** The timeline with each clip a speed-ramp cut touches carrying its plan; the same object when the reel has no speed-ramp cut. */
export function withSpeedPlans<T extends { clips: Clip[] }>(timeline: T, plan: SpeedRampReelPlan | null): T {
  if (!plan || plan.clips.size === 0) return timeline;
  return { ...timeline, clips: timeline.clips.map((clip) => (plan.clips.has(clip.id) ? ({ ...clip, speedPlan: plan.clips.get(clip.id) } as PlannedClip) : clip)) };
}

/** True when any cut of the reel is a speed ramp (so the composition has a plan to make). */
export const hasSpeedRamps = (timeline: { clips: readonly Pick<Clip, "transitionIn">[] }) => timeline.clips.some(hasSpeedRampIn);

// ── Media ───────────────────────────────────────────────────────

export type SpeedRampWindow = {
  trimBefore: number;
  trimAfter: number;
  /** The mean rate since the first frame, the rate the media element is asked for. */
  playbackRate: number;
  /** The clip's own sound at this frame: faded where the picture runs far from its mean speed. */
  gain: number;
  /** The source frame this frame shows. */
  sourceFrame: number;
};

/**
 * What the media element is asked to play at `frameInClip` under a plan, the
 * counterpart of `mediaWindow` (frames.ts): the media starts at the plan's
 * first source frame, and its rate is the mean since then, so every frame
 * lands exactly on the plan's position. Without pre-roll the first frame is
 * the clip's usual `trimBefore`.
 */
export function speedRampMediaWindow(clip: ClipLike, plan: ClipSpeedPlan, frameInClip: number, fps: number = REEL_FORMAT.fps): SpeedRampWindow {
  const frames = plan.frames;
  const f = Math.min(frames - 1, Math.max(0, Math.round(frameInClip)));
  const source = (index: number) => sourceFrameAt(clip, plan.position[Math.min(frames - 1, Math.max(0, index))], frames, fps);
  const trimBefore = Math.max(0, Math.round(source(0)));
  let top = 0;
  for (let index = 0; index < frames; index++) top = Math.max(top, source(index));
  const speed = clip.speed || 1;
  const here = source(f);
  const playbackRate = f > 0 ? (here - trimBefore) / f : Math.max(0.0625, (source(1) - source(0)) || speed);
  const ownRate = clip.ramp ? rampSpeedAt(clip.ramp, frames > 1 ? f / frames : 0) : 1;
  return {
    trimBefore,
    trimAfter: Math.max(Math.ceil(top) + 1, trimBefore + frames * speed + 1),
    playbackRate: Math.max(0.0625, playbackRate),
    gain: rampGain(plan.rate[f] * ownRate),
    sourceFrame: here,
  };
}

/** True when two consecutive frames of the plan show the same source frame (a frozen frame): the thing this module exists not to do. */
export function planHasFrozenFrame(clip: ClipLike, plan: ClipSpeedPlan, fps: number = REEL_FORMAT.fps): boolean {
  if (clip.kind === "IMAGE") return false;
  for (let f = 1; f < plan.frames; f++) {
    if (Math.abs(sourceFrameAt(clip, plan.position[f], plan.frames, fps) - sourceFrameAt(clip, plan.position[f - 1], plan.frames, fps)) < 1e-9) return true;
  }
  return false;
}
