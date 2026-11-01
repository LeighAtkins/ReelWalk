import { randomUUID } from "node:crypto";
import {
  acceptPassed, checkTake, extendFrom, nextPlanStep, phaseCredits, planEngine, planPhase, planStateSchema, planTimeline, readMotion, pickMatchingFrame, shotPlanSchema, transcriptSchema,
  takeFrames, takePrompt, withTakeStarted, type Continuity, type Gray, type PlanShot, type PlanState, type PlanStep, type ShotPlan, type TakeMeasure,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";

/**
 * The shot plan runner (ADR 0104): the worker's half of a plan. Each pass claims one due plan under a lease, brings its
 * takes' statuses up to date, accepts what passed, then does the one next thing `nextPlanStep` asks for: a storyboard
 * keyframe, a take, a take's check, or the reel. Waiting for the owner parks the plan ("waiting") until they act.
 *
 * The paid and provider parts are injected (`PlanDeps`): the cloud worker wires them to Vertex, S3 and the web's own
 * generation path (shot-plans-deps.ts), so a take is reserved, charged, queued and composed exactly like one asked
 * for in the editor, and tests run the whole loop on fakes.
 */

export type PlanUser = { id: string; workspaceId: string; email: string };
export type FrameRef = { assetId: string; atMs: number };

export type PlanDeps = {
  /** Make and store one keyframe still; returns its new library asset id. */
  makeKeyframe(input: { user: PlanUser; planId: string; plan: ShotPlan; shot: PlanShot; end: "start" | "end"; presenterId: string | null }): Promise<string>;
  /** Start a take through the web's generation path; returns the generation's id and what it costs. */
  startTake(input: {
    user: PlanUser; requestId: string; prompt: string; shot: PlanShot; first: FrameRef | null; last: FrameRef | null;
    /** Which model and tier (ADR 0105), and the earlier Omni take to carry on from instead of the frames. */
    engine: "veo" | "omni"; tier: "draft" | "final"; extendOf: string | null;
  }): Promise<{ id: string; credits: number }>;
  /** A generation's state. */
  takeStatus(id: string): Promise<{ status: "waiting" | "succeeded" | "failed"; assetId?: string; durationMs?: number; error?: string | null }>;
  /** Grey frames of a take (72×128, 30 a second) and of a still, 0..255 as the motion code reads them. */
  takeFrames(assetId: string): Promise<{ t: number; gray: Gray }[]>;
  stillFrame(frame: FrameRef): Promise<Gray>;
  /** Whether the place stays one place through a take (the continuity judge); null when it could not be asked. */
  judgeTake(assetId: string): Promise<Continuity | null>;
  requestId(planId: string, shotId: string, takeIndex: number): string;
  log?(line: string): void;
};

export const PLAN_LEASE_MS = 5 * 60_000;
/** How soon a plan with a take in flight is looked at again. */
export const PLAN_POLL_MS = 20_000;
const STEPS_PER_PASS = 4;

/** What a take's grey frames say against its planned stills: the move across its middle, and how close its ends come. */
export function measureTake(frames: { t: number; gray: Gray }[], start: Gray | null, end: Gray | null): TakeMeasure {
  if (frames.length < 4) return { motion: null, startChange: null, endChange: null };
  const n = frames.length;
  // Five frames across the middle 60 %: the move itself, not Veo's ease in and out.
  const middle = [0.2, 0.35, 0.5, 0.65, 0.8].map((f) => frames[Math.min(n - 1, Math.round(f * (n - 1)))]);
  const opening = frames.slice(0, 3);
  const closing = frames.slice(Math.max(0, n - 8));
  return {
    motion: readMotion(middle),
    startChange: start ? pickMatchingFrame(opening, start)?.change ?? null : null,
    endChange: end ? pickMatchingFrame(closing, end)?.change ?? null : null,
  };
}

/** Brings each take in flight up to date: made (now to be checked) or failed (its credits were returned). */
export async function refreshTakes(plan: ShotPlan, state: PlanState, deps: Pick<PlanDeps, "takeStatus">): Promise<PlanState> {
  const shots = { ...state.shots };
  for (const shot of plan.shots) {
    const s = shots[shot.id];
    if (!s) continue;
    const takes = await Promise.all(s.takes.map(async (take) => {
      if (take.status !== "queued" && take.status !== "generating") return take;
      const now = await deps.takeStatus(take.aiShotId);
      if (now.status === "succeeded" && now.assetId) return { ...take, status: "checking" as const, assetId: now.assetId };
      if (now.status === "failed") return { ...take, status: "failed" as const, credits: 0, verdict: { pass: false, problems: [now.error ?? "The take could not be made."], notes: [] } };
      return { ...take, status: "generating" as const };
    }));
    shots[shot.id] = { ...s, takes };
  }
  return { ...state, shots };
}

type Row = { id: string; workspaceId: string; approval: string; budgetCredits: number; presenterId: string | null; plan: unknown; state: unknown; reelId: string | null; createdBy: PlanUser };

/** One step of a plan; returns the new state and how the plan should be left. */
export async function runPlanStep(row: Row, plan: ShotPlan, state: PlanState, step: PlanStep, deps: PlanDeps, durations: Map<string, number>, speechEnds: Map<string, number | null> = new Map()): Promise<{ state: PlanState; status?: "waiting" | "done" | "running"; waitingFor?: string; reelId?: string; delayMs?: number }> {
  const user = { ...row.createdBy, workspaceId: row.workspaceId };
  const takeAsset = (aiShotId: string) => {
    for (const shot of plan.shots) {
      const take = state.shots[shot.id]?.takes.find((t) => t.aiShotId === aiShotId);
      if (take?.assetId) return { assetId: take.assetId, durationMs: durations.get(take.assetId) ?? shot.seconds * 1000 };
    }
    return null;
  };
  switch (step.kind) {
    case "keyframes": {
      const { shotId, end } = step.frames[0];
      const shot = plan.shots.find((s) => s.id === shotId)!;
      const assetId = await deps.makeKeyframe({ user, planId: row.id, plan, shot, end, presenterId: shot.presenter ? row.presenterId : null });
      shot[end] = { ...shot[end], assetId, atMs: 0 };
      deps.log?.(`shot-plan ${row.id}: keyframe ${shotId} ${end} -> ${assetId}`);
      return { state };
    }
    case "wait":
      return step.reason === "generating" ? { state, status: "running", delayMs: PLAN_POLL_MS } : { state, status: "waiting", waitingFor: step.shotId ? `${step.reason}:${step.shotId}` : step.reason };
    case "take": {
      const shot = plan.shots.find((s) => s.id === step.shotId)!;
      const tier = planPhase(state) === "draft" ? "draft" as const : "final" as const;
      // Carry on from the previous take with Omni's scene extension where the rule allows (never from speech near its
      // end), else start from that take's real last frame as a still (ADR 0105).
      const extendOf = extendFrom(plan, state, shot.id, (aiShotId) => {
        const made = takeAsset(aiShotId);
        return made ? { durationMs: made.durationMs, speechEndMs: speechEnds.get(made.assetId) ?? null } : null;
      });
      const { first, last } = extendOf ? { first: null, last: null } : takeFrames(plan, state, shot.id, takeAsset);
      const index = state.shots[shot.id]?.takes.length ?? 0;
      const started = await deps.startTake({ user, requestId: deps.requestId(row.id, shot.id, index), prompt: takePrompt(plan, shot, step.note), shot, first, last, engine: planEngine(state), tier, extendOf });
      deps.log?.(`shot-plan ${row.id}: ${tier} take ${shot.id} #${step.attempt} -> ${started.id}${extendOf ? ` (extends ${extendOf})` : ""}`);
      return { state: withTakeStarted(state, shot.id, { aiShotId: started.id, status: "queued", credits: started.credits, tier, ...(step.note ? { note: step.note.slice(0, 400) } : {}) }), delayMs: PLAN_POLL_MS };
    }
    case "check": {
      const shot = plan.shots.find((s) => s.id === step.shotId)!;
      const s = state.shots[shot.id];
      const take = s.takes.find((t) => t.aiShotId === step.aiShotId)!;
      const { first, last } = takeFrames(plan, state, shot.id, takeAsset);
      const frames = await deps.takeFrames(take.assetId!);
      const continuity = await deps.judgeTake(take.assetId!).catch(() => null);
      const measured = { ...measureTake(frames, first ? await deps.stillFrame(first) : null, last ? await deps.stillFrame(last) : null), continuity };
      const verdict = checkTake(shot, measured);
      deps.log?.(`shot-plan ${row.id}: check ${shot.id} ${take.aiShotId}: ${verdict.pass ? "passed" : verdict.problems.join(" ")} (end ${measured.endChange?.toFixed(3) ?? "-"}, ${measured.motion?.kind ?? "?"})`);
      const takes = s.takes.map((t) => t.aiShotId === take.aiShotId ? { ...t, status: verdict.pass ? "passed" as const : "failed" as const, verdict } : t);
      return { state: { ...state, shots: { ...state.shots, [shot.id]: { ...s, takes } } } };
    }
    case "assemble": {
      const timeline = planTimeline(plan, state, takeAsset);
      const title = plan.title.slice(0, 80);
      const reel = row.reelId
        ? await prisma.reel.update({ where: { id: row.reelId }, data: { timeline: timeline as never, revision: { increment: 1 } } })
        : await prisma.reel.create({ data: { workspaceId: row.workspaceId, title, timeline: timeline as never } });
      deps.log?.(`shot-plan ${row.id}: assembled ${timeline.clips.length} take(s) into reel ${reel.id}`);
      return { state: { ...state, assembled: true, reelId: reel.id }, reelId: reel.id };
    }
    case "done":
      return { state, status: "done" };
  }
}

/** One pass: claim a due running plan and advance it a few steps. True when there was a plan to work on. */
export async function processShotPlans(deps: PlanDeps): Promise<boolean> {
  const now = new Date();
  const free = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
  const due = await prisma.shotPlan.findFirst({ where: { status: "running", nextRunAt: { lte: now }, ...free }, orderBy: { nextRunAt: "asc" }, select: { id: true } });
  if (!due) return false;
  const token = randomUUID();
  const claimed = await prisma.shotPlan.updateMany({ where: { id: due.id, status: "running", ...free }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + PLAN_LEASE_MS) } });
  if (claimed.count !== 1) return true;
  const row = await prisma.shotPlan.findUniqueOrThrow({ where: { id: due.id }, include: { createdBy: { select: { id: true, workspaceId: true, email: true } } } });
  const save = (data: Record<string, unknown>) => prisma.shotPlan.updateMany({ where: { id: row.id, leaseToken: token }, data });
  try {
    const plan = shotPlanSchema.parse(row.plan);
    let state = planStateSchema.parse(row.state ?? {});
    const options = { approval: row.approval as "auto" | "storyboard" | "each-take", budgetCredits: row.budgetCredits };
    const durations = new Map<string, number>();
    // When each take's speech ends (its transcript's last word): extending runs a voiced take's words on (ADR 0105).
    const speechEnds = new Map<string, number | null>();
    state = await refreshTakes(plan, state, deps);
    for (const take of Object.values(state.shots).flatMap((s) => s.takes)) {
      if (take.assetId && !durations.has(take.assetId)) {
        const asset = await prisma.mediaAsset.findUnique({ where: { id: take.assetId }, select: { durationMs: true, transcript: true } });
        if (asset?.durationMs) durations.set(take.assetId, asset.durationMs);
        const words = transcriptSchema.safeParse(asset?.transcript).data?.words;
        speechEnds.set(take.assetId, words?.length ? words[words.length - 1].e : null);
      }
    }
    let status: string = "running", waitingFor: string | null = null, delayMs = 0, reelId = row.reelId;
    for (let i = 0; i < STEPS_PER_PASS; i++) {
      state = acceptPassed(plan, state, options);
      const step = nextPlanStep(plan, state, options, phaseCredits(state));
      const out = await runPlanStep({ ...row, reelId }, plan, state, step, deps, durations, speechEnds);
      state = out.state;
      if (out.reelId) reelId = out.reelId;
      // Save after every step: a take started is money spent, and must never be started again after a crash.
      await save({ plan: plan as never, state: state as never, reelId });
      if (out.status) { status = out.status; waitingFor = out.waitingFor ?? null; }
      if (out.delayMs) delayMs = out.delayMs;
      if (out.status || out.delayMs || step.kind === "assemble") break;
    }
    await save({ status, waitingFor, nextRunAt: new Date(Date.now() + delayMs), leaseToken: null, leaseUntil: null, error: null });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    deps.log?.(`shot-plan ${row.id}: ${message}`);
    // A step that failed is tried once more a minute later; failing the same way again stops the plan for the owner.
    const again = row.error === message;
    await save({ error: message, ...(again ? { status: "failed" } : {}), nextRunAt: new Date(Date.now() + 60_000), leaseToken: null, leaseUntil: null });
  }
  return true;
}
