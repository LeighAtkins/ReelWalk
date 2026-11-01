import { z } from "zod";
import { aiClipCredits } from "./ai";
import { rampPreset } from "./ramp";
import { addClips, clipSchema, emptyTimeline, type Timeline } from "./timeline";
import { MOVE_IDS } from "./moves";
import type { MotionRead } from "./motion-kind";

/**
 * Shot plans (ADR 0104): an AI sequence planned as a list of shots, each with its start and end frame, its camera move
 * and the transition that ties it to the next, then made one take at a time with a check after each.
 *
 * Why: generating a sequence shot by shot from prompts drifts. One take goes off the rails, the shots around it no
 * longer join, and the whole sequence is made again. Here the joins are fixed before anything is paid for:
 *
 *  1. Plan: the shot list, checked by `planIssues` for the continuity faults the owner keeps finding by hand (a whip
 *     that turns against the camera, the same room from the same spot twice in a row, a reveal already in view).
 *  2. Storyboard: a keyframe still for each planned start and end. Shot n+1 starting "from the previous shot" starts on
 *     shot n's end keyframe, so the join is the same picture on both sides.
 *  3. Takes, in order: each take is asked to fly from its start keyframe to its end keyframe, then checked by
 *     `checkTake` (did it land on the end frame, did the camera move the planned way). A take that fails is made again
 *     with what went wrong (`retryNote`); nothing after it has been made yet, so nothing else is redone. When the next
 *     shot continues from this one, it starts from this take's real last frame.
 *  4. Assemble: the accepted takes, in order, with the planned transitions (`planClips`).
 *
 * Everything here is pure; the web plans and the worker runs it (`nextPlanStep`).
 */

export const PLAN_MOTIONS = [
  "still", "push-in", "pull-out", "pan-left", "pan-right", "tilt-up", "tilt-down", "rise", "descend",
  "orbit-left", "orbit-right", "roll-left", "roll-right",
] as const;
export type PlanMotion = (typeof PLAN_MOTIONS)[number];

/**
 * How a shot hands over to the next:
 * - continuous: no visible cut. The next shot starts on this shot's last frame and carries on (one long take in chunks).
 * - cut: a hard cut to another room or point of view.
 * - match-cut: a cut where the camera keeps moving the same way on both sides.
 * - whip: a fast pan (left, right, up or down) blurs out of this shot and into the next, both moving that way.
 * - speed-ramp: this shot speeds up into the cut and the next lands at speed: momentum, never a sliced shot.
 * - dissolve: a soft crossfade (house style: rare).
 */
export const PLAN_TRANSITIONS = ["continuous", "cut", "match-cut", "whip", "speed-ramp", "dissolve"] as const;
export type PlanTransition = (typeof PLAN_TRANSITIONS)[number];
export const WHIP_DIRECTIONS = ["left", "right", "up", "down"] as const;

export const PLAN_LIMITS = { shots: 12, totalSeconds: 90, attempts: 3 } as const;

const text = (max: number) => z.string().trim().min(3).max(max);

export const planFrameSchema = z.object({
  /** What the still shows: where the camera is, what is in frame, where the presenter is and how big. */
  description: text(600),
  /**
   * keyframe: a still made for the storyboard (or one the owner picked). previous: the previous shot's end, so the two
   * shots join on one picture (the previous shot's transition is continuous). free: the take decides (an end only, when
   * the next shot cuts away anyway).
   */
  source: z.enum(["keyframe", "previous", "free"]).default("keyframe"),
  /** The still, once made or picked: a library asset (a photo, or a video and the moment in it). */
  assetId: z.string().min(1).max(64).optional(),
  atMs: z.number().int().min(0).max(600_000).optional(),
});
export type PlanFrame = z.infer<typeof planFrameSchema>;

export const planShotSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/),
  /** What the shot is for: hook, reveal, feature, transition, outro. */
  purpose: z.enum(["hook", "reveal", "feature", "transition", "outro"]),
  /** The room or place (kitchen, terrace, entrance hall). */
  place: text(60),
  /** Where the camera is: eye level, low, high, overhead, drone, close on a detail. */
  pov: text(60),
  /** What a reveal shows for the first time (the chandelier): it must not be in view before this shot. */
  reveals: z.string().trim().max(80).optional(),
  seconds: z.union([z.literal(4), z.literal(8)]),
  /** How long it plays in the reel (a take can play faster than it was made: an 8 s flight in 4 s). */
  playSeconds: z.number().min(0.5).max(16).optional(),
  motion: z.enum(PLAN_MOTIONS),
  /** One of the moves table's moves (ADR 0076), for its words. */
  move: z.enum(MOVE_IDS).optional(),
  /** What the camera does, in the operator's words: "flies forward through the arch and banks right into the kitchen". */
  action: text(400),
  start: planFrameSchema,
  end: planFrameSchema,
  presenter: z.boolean().default(false),
  line: z.string().trim().min(3).max(200).optional(),
  transitionOut: z.object({
    kind: z.enum(PLAN_TRANSITIONS),
    direction: z.enum(WHIP_DIRECTIONS).optional(),
  }).default({ kind: "cut" }),
});
export type PlanShot = z.infer<typeof planShotSchema>;

export const shotPlanSchema = z.object({
  version: z.literal(1),
  title: text(80),
  /** One sentence repeated in every keyframe and take so the shots share one place and light. */
  look: text(400),
  /** What the presenter wears, word for word in every still and take she is in. */
  outfit: z.string().trim().max(160).optional(),
  shots: z.array(planShotSchema).min(1).max(PLAN_LIMITS.shots),
});
export type ShotPlan = z.infer<typeof shotPlanSchema>;

export type PlanIssue = { shotId: string; level: "error" | "warning"; message: string };

/** The screen motion a camera motion makes, as the measured read sees it (content velocity, ADR 0074). */
export function expectedRead(motion: PlanMotion): { axis: "x" | "y" | "zoom" | "rotate" | "none"; sign: 1 | -1 } {
  switch (motion) {
    case "still": return { axis: "none", sign: 1 };
    case "push-in": return { axis: "zoom", sign: 1 };
    case "pull-out": return { axis: "zoom", sign: -1 };
    // The camera turns right, so the picture slides left.
    case "pan-right": case "orbit-left": return { axis: "x", sign: -1 };
    case "pan-left": case "orbit-right": return { axis: "x", sign: 1 };
    // The camera looks or rises up, so the picture slides down.
    case "tilt-up": case "rise": return { axis: "y", sign: 1 };
    case "tilt-down": case "descend": return { axis: "y", sign: -1 };
    case "roll-right": return { axis: "rotate", sign: 1 };
    case "roll-left": return { axis: "rotate", sign: -1 };
  }
}

/** The camera motion that matches a whip's direction. */
const WHIP_MOTION: Record<(typeof WHIP_DIRECTIONS)[number], PlanMotion[]> = {
  left: ["pan-left", "orbit-right"], right: ["pan-right", "orbit-left"], up: ["tilt-up", "rise"], down: ["tilt-down", "descend"],
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/**
 * What is wrong with a plan before anything is made. Errors block the storyboard; warnings are shown. Each rule is a
 * fault the owner found by hand in a finished reel (ADR 0104).
 */
export function planIssues(plan: ShotPlan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (shotId: string, level: PlanIssue["level"], message: string) => issues.push({ shotId, level, message });
  const ids = new Set<string>();
  let total = 0;
  plan.shots.forEach((shot, i) => {
    const prev = i > 0 ? plan.shots[i - 1] : null;
    const next = plan.shots[i + 1] ?? null;
    if (ids.has(shot.id)) add(shot.id, "error", "Two shots share this id.");
    ids.add(shot.id);
    total += shot.playSeconds ?? shot.seconds;
    const out = shot.transitionOut;

    if (shot.line && !shot.presenter) add(shot.id, "error", "A spoken line needs the presenter in the shot.");
    if (shot.line && shot.line.split(/\s+/).length / 2.6 > shot.seconds - 0.5) add(shot.id, "warning", `The line is too long to say in ${shot.seconds} s.`);
    if (i === 0 && shot.start.source === "previous") add(shot.id, "error", "The first shot has no previous shot to start from.");
    if (shot.start.source === "free") add(shot.id, "error", "A shot's start is planned: a keyframe, or the previous shot's end.");

    // Continuous: the next shot starts on this one's last frame, so the end must be a real, planned picture.
    if (prev && shot.start.source === "previous" && prev.transitionOut.kind !== "continuous") {
      add(shot.id, "error", "This shot starts on the previous shot's last frame, so that shot's transition has to be continuous.");
    }
    if (out.kind === "continuous") {
      if (!next) add(shot.id, "error", "The last shot cannot continue into another.");
      else if (next.start.source !== "previous") add(next.id, "error", "The shot before carries on into this one, so this one starts from its last frame.");
      if (shot.end.source === "free") add(shot.id, "error", "A shot that carries on into the next needs a planned end frame.");
      if (next) {
        const a = expectedRead(shot.motion), b = expectedRead(next.motion);
        if (a.axis !== "none" && a.axis === b.axis && a.sign !== b.sign) add(next.id, "error", `The camera reverses at a join with no cut (${shot.motion} into ${next.motion}).`);
      }
    }
    // A whip is the camera turning fast: both sides have to turn the way the whip goes (the staircase "spin" that never spun).
    if (out.kind === "whip") {
      if (!out.direction) add(shot.id, "error", "Say which way the whip goes.");
      else if (next) {
        const want = WHIP_MOTION[out.direction];
        if (!want.includes(shot.motion)) add(shot.id, "error", `A whip ${out.direction} needs this shot's camera turning ${out.direction} into it (it is ${shot.motion}).`);
        if (!want.includes(next.motion)) add(next.id, "error", `A whip ${out.direction} needs this shot to open still turning ${out.direction} (it is ${next.motion}).`);
      }
    }
    if (out.kind === "match-cut" && next && (shot.motion !== next.motion || shot.motion === "still")) {
      add(next.id, "error", `A match cut carries one camera move across the cut: ${shot.motion} into ${next.motion} does not match.`);
    }
    if (out.kind === "speed-ramp" && shot.motion === "still") add(shot.id, "error", "A speed ramp needs the camera moving into the cut.");
    if (out.kind === "dissolve" && plan.shots.filter((s) => s.transitionOut.kind === "dissolve").length > 2) add(shot.id, "warning", "More than two dissolves: keep them for one or two moments.");

    // Variety: the same room from the same spot again is the AI-edit trap of cutting one shot into pieces.
    if (prev && prev.transitionOut.kind !== "continuous" && prev.place.toLowerCase() === shot.place.toLowerCase() && prev.pov.toLowerCase() === shot.pov.toLowerCase()) {
      add(shot.id, "error", `The same place from the same point of view as the shot before (${shot.place}, ${shot.pov}): change the room or the angle.`);
    }
    // A reveal shows something for the first time: it must not be in view before (the chandelier already in the presenter's shot).
    if (shot.reveals) {
      const key = words(shot.reveals);
      const seen = [shot.start.description, ...(prev ? [prev.start.description, prev.end.description] : [])].map(words);
      if (key.length && seen.some((w) => key.every((k) => w.includes(k)))) add(shot.id, "warning", `${shot.reveals} is described as in view before this shot reveals it.`);
    }
  });
  if (total > PLAN_LIMITS.totalSeconds) add(plan.shots[plan.shots.length - 1].id, "error", `The plan runs ${Math.round(total)} s; a reel is at most ${PLAN_LIMITS.totalSeconds} s.`);
  return issues;
}

export const planBlocked = (issues: readonly PlanIssue[]) => issues.some((i) => i.level === "error");

// ── Takes ───────────────────────────────────────────────────────

/** What was measured on a finished take (worker): its camera motion across the middle, and how close its ends are to the planned stills. */
/**
 * A vision model's read of whether the place stays the same place: across a take's frames, or between a shot's start and
 * end stills. The motion and landing checks cannot see a wall that dissolves into shelves halfway through a take while
 * both ends still match (the first demo's kitchen, ADR 0104), so this is asked in words.
 */
export const continuitySchema = z.object({ consistent: z.boolean(), problems: z.array(z.string().max(300)).max(6) });
export type Continuity = z.infer<typeof continuitySchema>;

export const CONTINUITY_TAKE_PROMPT = [
  "These images are frames from ONE continuous camera move through a real property, in time order. A real camera only changes what is in view; the place itself never changes.",
  "Look for anything that changes what it is between frames, beyond what the camera's own movement reveals or hides: a wall becoming shelves or cabinets, a window or doorway appearing, vanishing or moving, furniture or fittings appearing, vanishing or turning into something else, a room's layout, materials or colours changing, a person's face or clothes changing.",
  "consistent: true only when nothing changes like that. problems: each change in a few plain words, saying where in the frame and between which frames (for example \"the white wall behind the island turns into open shelves with pottery between frames 2 and 3\"). Answer with JSON only.",
].join(" ");

export const CONTINUITY_KEYFRAMES_PROMPT = [
  "The first image is where a camera move starts and the second is where it ends, in the same real property. The camera will move from one to the other without a cut.",
  "Check that the second image shows the same place: everything the first image shows that would still be in view, including what is visible through doorways, arches and windows, must look the same in the second (the same walls, windows, cabinets, shelves, furniture, materials, colours and light). New things may appear only where the first image could not see.",
  "consistent: true only when the two can be one continuous place. problems: each contradiction in a few plain words (for example \"through the arch the kitchen has a white wall with a range hood; in the end frame that wall has open shelves\"). Answer with JSON only.",
].join(" ");

export type TakeMeasure = {
  motion: MotionRead | null;
  /** Whether the place stays the same place through the take; null when it could not be judged. */
  continuity?: Continuity | null;
  /** Normalised difference after alignment, 0 = the same picture (motion.ts pickMatchingFrame). Null when there was no planned still. */
  startChange: number | null;
  endChange: number | null;
};

export type TakeVerdict = { pass: boolean; problems: string[]; notes: string[] };

/** How close a take's end must come to its planned end still: a little looser than a match cut (2 %), as Veo eases in. */
export const LANDING_CHANGE = 0.06;
/** A take must open on its start still; Veo is given it, so this only catches a take that cut away at once. */
export const OPENING_CHANGE = 0.08;
const MOVING = 0.03;

/** Whether a finished take did what its shot planned. */
export function checkTake(shot: PlanShot, measured: TakeMeasure): TakeVerdict {
  const problems: string[] = [], notes: string[] = [];
  if (measured.startChange !== null && measured.startChange > OPENING_CHANGE) problems.push("It does not open on the planned start frame.");
  if (measured.endChange !== null && shot.end.source !== "free" && measured.endChange > LANDING_CHANGE) problems.push("It does not land on the planned end frame.");
  if (measured.continuity && !measured.continuity.consistent) {
    problems.push(`The place changes during the take: ${(measured.continuity.problems.length ? measured.continuity.problems : ["something in the room turns into something else"]).join("; ")}.`);
  } else if (measured.continuity === null) notes.push("Whether the room stays the same could not be judged; look at it.");
  const read = measured.motion;
  const want = expectedRead(shot.motion);
  if (!read || read.confidence < 0.3) notes.push("The camera move could not be read reliably; look at it.");
  else if (want.axis === "none") {
    if (read.speed > MOVING * 2) problems.push(`The camera moves (${describeRead(read)}) where it should be still.`);
  } else {
    const value = want.axis === "x" ? read.tx : want.axis === "y" ? read.ty : want.axis === "zoom" ? read.zoom : read.rotate;
    const size = want.axis === "zoom" || want.axis === "rotate" ? Math.abs(value) * 0.5 : Math.abs(value);
    if (size < MOVING) problems.push(`The camera hardly moves; it should ${shot.motion}.`);
    else if (Math.sign(value) !== want.sign) problems.push(`The camera goes the wrong way: ${describeRead(read)}, planned ${shot.motion}.`);
  }
  return { pass: problems.length === 0, problems, notes };
}

function describeRead(read: MotionRead): string {
  switch (read.kind) {
    case "pan-x": return read.tx > 0 ? "it turns left" : "it turns right";
    case "pan-y": return read.ty > 0 ? "it tilts up" : "it tilts down";
    case "zoom-in": return "it pushes in";
    case "zoom-out": return "it pulls out";
    case "rotate": return read.rotate > 0 ? "it rolls right" : "it rolls left";
    default: return "it holds still";
  }
}

/** The words added to a retake's prompt: what the last take got wrong, as a correction. */
export function retryNote(shot: PlanShot, verdict: TakeVerdict): string {
  if (verdict.pass) return "";
  const lines = [`The previous attempt failed: ${verdict.problems.join(" ")}`];
  if (verdict.problems.some((p) => p.includes("wrong way") || p.includes("hardly moves") || p.includes("should be still"))) {
    lines.push(`The camera must ${shot.motion.replace("-", " ")}: ${shot.action}`);
  }
  if (verdict.problems.some((p) => p.includes("end frame"))) lines.push("Finish exactly on the supplied last frame: same position, same framing, same light.");
  if (verdict.problems.some((p) => p.includes("place changes"))) lines.push("Nothing in the property changes during the move: every wall, window, opening, cabinet and piece of furniture stays exactly as the start frame shows it; only the camera moves.");
  return lines.join(" ");
}

// ── Running a plan ──────────────────────────────────────────────

export const TAKE_STATUSES = ["queued", "generating", "checking", "passed", "failed", "accepted", "rejected"] as const;
export const takeSchema = z.object({
  aiShotId: z.string().min(1).max(64),
  assetId: z.string().min(1).max(64).optional(),
  status: z.enum(TAKE_STATUSES),
  verdict: z.object({ pass: z.boolean(), problems: z.array(z.string()), notes: z.array(z.string()) }).optional(),
  /** The owner's own note for a redo. */
  note: z.string().max(400).optional(),
  credits: z.number().int().min(0).default(0),
});
export type PlanTake = z.infer<typeof takeSchema>;

export const shotStateSchema = z.object({
  takes: z.array(takeSchema).default([]),
  /** The take that went into the reel. */
  acceptedAiShotId: z.string().optional(),
  /** Asked to make it again after it passed (or to try once more after the attempts ran out). */
  redo: z.object({ note: z.string().max(400).optional() }).optional(),
  /** Takes before this index were before the last redo: the attempts count from here. */
  attemptsFrom: z.number().int().min(0).default(0),
});
export type ShotState = z.infer<typeof shotStateSchema>;

export const planStateSchema = z.object({
  shots: z.record(z.string(), shotStateSchema).default({}),
  /** The owner said the storyboard is right (always true when the plan runs on its own). */
  storyboardApproved: z.boolean().default(false),
  reelId: z.string().optional(),
  /** The reel holds every accepted take (false again after a redo). */
  assembled: z.boolean().default(false),
});
export type PlanState = z.infer<typeof planStateSchema>;

export type PlanRunOptions = {
  /** storyboard: stop for the owner after the keyframes, then run the takes. each-take: also stop after every passed take. auto: never stop. */
  approval: "auto" | "storyboard" | "each-take";
  budgetCredits: number;
  maxAttempts?: number;
};

export type PlanStep =
  | { kind: "keyframes"; frames: { shotId: string; end: "start" | "end" }[] }
  | { kind: "wait"; reason: "storyboard" | "take-approval" | "take-failed" | "generating" | "budget"; shotId?: string }
  | { kind: "take"; shotId: string; attempt: number; note: string }
  | { kind: "check"; shotId: string; aiShotId: string }
  | { kind: "assemble" }
  | { kind: "done" };

/** The frames the storyboard still has to make: every planned keyframe without a still. */
export function missingKeyframes(plan: ShotPlan): { shotId: string; end: "start" | "end" }[] {
  const out: { shotId: string; end: "start" | "end" }[] = [];
  for (const shot of plan.shots) {
    if (shot.start.source === "keyframe" && !shot.start.assetId) out.push({ shotId: shot.id, end: "start" });
    if (shot.end.source === "keyframe" && !shot.end.assetId) out.push({ shotId: shot.id, end: "end" });
  }
  return out;
}

export const creditsSpent = (state: PlanState) => Object.values(state.shots).reduce((sum, s) => sum + s.takes.reduce((t, take) => t + (take.status === "failed" && !take.assetId ? 0 : take.credits), 0), 0);

/**
 * The one thing to do next, in order: make the missing keyframes; wait for the storyboard's approval; then, shot by
 * shot, make a take, check it, and either move on, make it again (up to maxAttempts) or stop for the owner. A shot is
 * only started when every shot before it has an accepted take, so a take that goes wrong never costs the shots after it.
 */
export function nextPlanStep(plan: ShotPlan, state: PlanState, options: PlanRunOptions, takeCredits: (shot: PlanShot) => number): PlanStep {
  const missing = missingKeyframes(plan);
  if (missing.length) return { kind: "keyframes", frames: missing };
  if (options.approval !== "auto" && !state.storyboardApproved) return { kind: "wait", reason: "storyboard" };
  const maxAttempts = options.maxAttempts ?? PLAN_LIMITS.attempts;
  for (const shot of plan.shots) {
    const s = state.shots[shot.id] ?? { takes: [], attemptsFrom: 0 };
    if (s.acceptedAiShotId && !s.redo) continue;
    const last = s.takes[s.takes.length - 1];
    if (last && (last.status === "queued" || last.status === "generating")) return { kind: "wait", reason: "generating", shotId: shot.id };
    if (last && last.status === "checking") return { kind: "check", shotId: shot.id, aiShotId: last.aiShotId };
    // A passed take waits for the owner (each-take); otherwise acceptPassed has already made it the accepted one.
    if (last && last.status === "passed" && !s.redo) return { kind: "wait", reason: "take-approval", shotId: shot.id };
    const attempts = s.takes.length - (s.attemptsFrom ?? 0);
    if (!s.redo && attempts >= maxAttempts) return { kind: "wait", reason: "take-failed", shotId: shot.id };
    if (creditsSpent(state) + takeCredits(shot) > options.budgetCredits) return { kind: "wait", reason: "budget", shotId: shot.id };
    const lastVerdict = s.redo ? undefined : [...s.takes].reverse().find((t) => t.verdict && !t.verdict.pass)?.verdict;
    const note = [s.redo?.note, lastVerdict ? retryNote(shot, lastVerdict) : ""].filter(Boolean).join(" ");
    return { kind: "take", shotId: shot.id, attempt: s.redo ? 1 : attempts + 1, note };
  }
  return state.assembled ? { kind: "done" } : { kind: "assemble" };
}

/** A new take started for a shot: it is recorded, and a redo it answers is used up (its attempts count afresh). */
export function withTakeStarted(state: PlanState, shotId: string, take: PlanTake): PlanState {
  const s = state.shots[shotId] ?? { takes: [], attemptsFrom: 0 };
  const attemptsFrom = s.redo ? s.takes.length : s.attemptsFrom ?? 0;
  return { ...state, shots: { ...state.shots, [shotId]: { ...s, redo: undefined, attemptsFrom, takes: [...s.takes, take] } } };
}

/**
 * The owner asks for a shot again. Every later shot that continues from it (a chain of continuous joins) is made again
 * too: each started on the last frame of a take that is being replaced. The reel is assembled again afterwards.
 */
export function requestRedo(plan: ShotPlan, state: PlanState, shotId: string, note?: string): { state: PlanState; shotIds: string[] } {
  const index = plan.shots.findIndex((s) => s.id === shotId);
  if (index < 0) throw new Error(`No shot ${shotId} in this plan.`);
  const shotIds = [shotId];
  for (let i = index; i < plan.shots.length - 1 && plan.shots[i].transitionOut.kind === "continuous"; i++) shotIds.push(plan.shots[i + 1].id);
  const shots = { ...state.shots };
  for (const id of shotIds) {
    const s = shots[id] ?? { takes: [], attemptsFrom: 0 };
    shots[id] = { ...s, redo: id === shotId && note ? { note } : {} };
  }
  return { state: { ...state, shots, assembled: false }, shotIds };
}

/** A passed take with nothing to wait for becomes the shot's accepted take (the runner calls this before nextPlanStep). */
export function acceptPassed(plan: ShotPlan, state: PlanState, options: Pick<PlanRunOptions, "approval">): PlanState {
  if (options.approval === "each-take") return state;
  const shots = { ...state.shots };
  for (const shot of plan.shots) {
    const s = shots[shot.id];
    const last = s?.takes[s.takes.length - 1];
    if (s && last?.status === "passed" && !s.redo) {
      shots[shot.id] = { ...s, acceptedAiShotId: last.aiShotId, takes: s.takes.map((t) => t === last ? { ...t, status: "accepted" as const } : t) };
    }
  }
  return { ...state, shots };
}

/**
 * The owner keeps a take: a passed one they were asked to approve, or one that failed its checks but is right to their
 * eye (the checks can be wrong). Later shots continuing from it then start from its last frame.
 */
export function acceptTake(state: PlanState, shotId: string, aiShotId: string): PlanState {
  const s = state.shots[shotId];
  const take = s?.takes.find((t) => t.aiShotId === aiShotId);
  if (!s || !take) throw new Error("That take is not one of this shot's.");
  if (!take.assetId) throw new Error("That take was not made, so it cannot be kept.");
  return { ...state, assembled: false, shots: { ...state.shots, [shotId]: { ...s, redo: undefined, acceptedAiShotId: aiShotId,
    takes: s.takes.map((t) => t.aiShotId === aiShotId ? { ...t, status: "accepted" as const } : t.status === "accepted" ? { ...t, status: "rejected" as const } : t) } } };
}

/**
 * The frames a take is made between. The start: the shot's keyframe, or, continuing, the previous shot's accepted take
 * at its last frame (the real picture the cut joins), else the previous shot's end keyframe. The end: its keyframe, or
 * none when free.
 */
export function takeFrames(plan: ShotPlan, state: PlanState, shotId: string, takeAsset: (aiShotId: string) => { assetId: string; durationMs: number } | null):
  { first: { assetId: string; atMs: number } | null; last: { assetId: string; atMs: number } | null } {
  const index = plan.shots.findIndex((s) => s.id === shotId);
  const shot = plan.shots[index];
  if (!shot) throw new Error(`No shot ${shotId} in this plan.`);
  const still = (frame: PlanFrame) => frame.assetId ? { assetId: frame.assetId, atMs: frame.atMs ?? 0 } : null;
  let first = still(shot.start);
  if (shot.start.source === "previous" && index > 0) {
    const prev = plan.shots[index - 1];
    const accepted = state.shots[prev.id]?.acceptedAiShotId;
    const made = accepted ? takeAsset(accepted) : null;
    // A frame short of the end: the last frame of a file is sometimes a repeat of the one before.
    first = made ? { assetId: made.assetId, atMs: Math.max(0, made.durationMs - 40) } : still(prev.end);
  }
  return { first, last: shot.end.source === "free" ? null : still(shot.end) };
}

/** The prompt for a take: the look, the action, the outfit, the frames' descriptions and any correction. */
export function takePrompt(plan: ShotPlan, shot: PlanShot, note = ""): string {
  return [
    shot.action,
    `It starts on: ${shot.start.source === "previous" ? "the previous shot's last frame, continuing the same camera move without a cut" : shot.start.description}.`,
    shot.end.source === "free" ? "" : `It ends on: ${shot.end.description}.`,
    plan.look,
    shot.presenter && plan.outfit ? `She wears ${plan.outfit}.` : "",
    "One continuous camera move, no cuts, no text.",
    note,
  ].filter(Boolean).join(" ").slice(0, 2000);
}

/** The description a keyframe still is made from, with the look (and the outfit when she is in it). */
export function keyframePrompt(plan: ShotPlan, shot: PlanShot, end: "start" | "end"): string {
  const frame = end === "start" ? shot.start : shot.end;
  return [
    `A single photorealistic 9:16 portrait frame of a property video: ${frame.description}.`,
    `Camera: ${shot.pov}, in the ${shot.place}.`,
    plan.look,
    shot.presenter && plan.outfit ? `The presenter wears ${plan.outfit}.` : "",
    end === "end" ? `This is where the camera arrives after it ${shot.action.replace(/\.$/, "")}. It is the same place as the start frame: everything the start frame shows that is still in view, including what is seen through doorways, arches and windows, looks exactly the same here (the same walls, windows, cabinets, shelves, furniture, materials and light).` : "",
    "No text, logos or watermarks.",
  ].filter(Boolean).join(" ").slice(0, 1500);
}

/** How each accepted take goes into the reel: in order, at its planned length, with its transition in. */
export function planClips(plan: ShotPlan, state: PlanState, takeAsset: (aiShotId: string) => { assetId: string; durationMs: number } | null) {
  return plan.shots.flatMap((shot, i) => {
    const accepted = state.shots[shot.id]?.acceptedAiShotId;
    const made = accepted ? takeAsset(accepted) : null;
    if (!made) return [];
    const into = i > 0 ? plan.shots[i - 1].transitionOut.kind : "cut";
    const playMs = Math.round((shot.playSeconds ?? made.durationMs / 1000) * 1000);
    return [{
      shotId: shot.id, assetId: made.assetId,
      // A take continuing from the one before opens on that take's last frame: skip it so the join shows no repeated frame.
      sourceStartMs: into === "continuous" ? 40 : 0, sourceEndMs: made.durationMs,
      speed: Math.max(0.25, Math.min(4, (made.durationMs - (into === "continuous" ? 40 : 0)) / playMs)),
      transitionIn: into === "dissolve" ? "fade" as const : "cut" as const,
      // The shot that speeds into the cut carries the ramp (ADR 0067's into-cut).
      rampOut: shot.transitionOut.kind === "speed-ramp",
    }];
  });
}

/** The reel's timeline from the accepted takes (silent: the voiced takes keep their own audio). */
export function planTimeline(plan: ShotPlan, state: PlanState, takeAsset: (aiShotId: string) => { assetId: string; durationMs: number } | null): Timeline {
  const clips = planClips(plan, state, takeAsset).map((c) => clipSchema.parse({
    id: `plan-${c.shotId}`, assetId: c.assetId, kind: "VIDEO", sourceStartMs: c.sourceStartMs, sourceEndMs: c.sourceEndMs,
    speed: Number(c.speed.toFixed(3)), transitionIn: c.transitionIn, ...(c.rampOut ? { ramp: rampPreset("into-cut") } : {}),
  }));
  return addClips(emptyTimeline(), clips);
}

// ── Planning ────────────────────────────────────────────────────

/** What one take of a shot costs: its length, plus the voice when it speaks (ADR 0038). */
export const shotCredits = (shot: Pick<PlanShot, "seconds" | "line">) => aiClipCredits(shot.seconds, Boolean(shot.line));
/** The plan made once with every take passing first time, and the budget that allows each shot a retake. */
export function planCredits(plan: ShotPlan): { once: number; withRetakes: number } {
  const once = plan.shots.reduce((sum, shot) => sum + shotCredits(shot), 0);
  return { once, withRetakes: once * 2 };
}

const nullable = (type: string | Record<string, unknown>) => (typeof type === "string" ? { type: [type, "null"] } : { anyOf: [type, { type: "null" }] });
const frameJson = {
  type: "object", additionalProperties: false, required: ["description", "source", "assetId", "atMs"],
  properties: { description: { type: "string" }, source: { type: "string", enum: ["keyframe", "previous", "free"] }, assetId: nullable("string"), atMs: nullable("integer") },
};

/** The planner's answer: a strict JSON schema (every field present, absent ones null), read back by parsePlannedShots. */
export const SHOT_PLAN_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "look", "outfit", "shots"],
  properties: {
    title: { type: "string" }, look: { type: "string" }, outfit: nullable("string"),
    shots: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "purpose", "place", "pov", "reveals", "seconds", "playSeconds", "motion", "move", "action", "start", "end", "presenter", "line", "transitionOut"],
        properties: {
          id: { type: "string" }, purpose: { type: "string", enum: ["hook", "reveal", "feature", "transition", "outro"] },
          place: { type: "string" }, pov: { type: "string" }, reveals: nullable("string"),
          seconds: { type: "integer", enum: [4, 8] }, playSeconds: nullable("number"),
          motion: { type: "string", enum: [...PLAN_MOTIONS] }, move: nullable({ type: "string", enum: [...MOVE_IDS] }),
          action: { type: "string" }, start: frameJson, end: frameJson, presenter: { type: "boolean" }, line: nullable("string"),
          transitionOut: {
            type: "object", additionalProperties: false, required: ["kind", "direction"],
            properties: { kind: { type: "string", enum: [...PLAN_TRANSITIONS] }, direction: nullable({ type: "string", enum: [...WHIP_DIRECTIONS] }) },
          },
        },
      },
    },
  },
} as const;

function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]));
  return value;
}

/**
 * The planner's answer as a plan: nulls dropped, ids made unique and safe, a frame naming an asset the planner was not
 * given turned back into a keyframe to make, and the rest checked by shotPlanSchema (which throws on anything else).
 */
export function parsePlannedShots(json: unknown, allowedAssetIds: readonly string[] = []): ShotPlan {
  const raw = dropNulls(json) as { shots?: Record<string, unknown>[] } & Record<string, unknown>;
  const seen = new Set<string>();
  const shots = (raw.shots ?? []).slice(0, PLAN_LIMITS.shots).map((shot, i) => {
    let id = String(shot.id ?? `shot-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || `shot-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const frameOf = (frame: unknown) => {
      const f = { ...(frame as Record<string, unknown>) };
      if (f.assetId !== undefined && !allowedAssetIds.includes(String(f.assetId))) { delete f.assetId; delete f.atMs; }
      if (typeof f.description === "string") f.description = f.description.slice(0, 600);
      return f;
    };
    return { ...shot, id, start: frameOf(shot.start), end: frameOf(shot.end) };
  });
  return shotPlanSchema.parse({ version: 1, ...raw, shots });
}
