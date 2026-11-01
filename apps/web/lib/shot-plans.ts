import { createHash } from "node:crypto";
import {
  MOVES, PLAN_LIMITS, PLAN_MOTIONS, SHOT_PLAN_JSON_SCHEMA, acceptTake, describeRecipe, parsePlannedShots, planBlocked, planCredits, planIssues, planStateSchema,
  finalizePlan, planEngine, planPhase, requestRedo, shotPlanSchema, styleRecipeSchema, type PlanIssue, type PlanState, type ShotPlan,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { z } from "zod";
import { structuredAnswer } from "./openai";
import { mediaScope } from "./media-scope";
import { toLibraryAssets } from "./library";
import { aiOmniConfigured } from "./ai-video";

/**
 * Shot plans (ADR 0104): the owner describes a sequence; Claude plans it shot by shot (start and end frames, camera
 * move, the transition into the next); planIssues checks the joins; the worker then makes the storyboard and the takes
 * one at a time (apps/worker/src/shot-plans.ts). This module is the web's half: planning, reading, and the owner's
 * decisions (start, approve the storyboard, keep a take, redo a shot, stop, edit the plan before anything is made).
 */

export const PLAN_STATUSES = ["planned", "running", "waiting", "done", "stopped", "failed"] as const;
export const PLAN_APPROVALS = ["auto", "storyboard", "each-take"] as const;
export type PlanApproval = (typeof PLAN_APPROVALS)[number];

export class ShotPlanError extends Error {}

export const SHOT_PLAN_INSTRUCTIONS = [
  "You plan a short vertical (9:16) AI video for a property or venue as a list of shots. Each shot is one AI video take of 4 or 8 seconds with one continuous camera move, made from a planned start frame to a planned end frame. The takes are made one at a time and checked, so the plan must make every join work before anything is made.",
  "For every shot give: id (short, lowercase, hyphens), purpose, place (the room or spot), pov (where the camera is: eye level, low, high, overhead, drone, close on a detail), seconds (4, or 8 for a long flight), playSeconds (how long it plays in the reel; an 8 s flight can play in 4 to 5 s for energy; null to play as made), motion (the camera's dominant move), move (one of the named moves when one fits, else null), action (what the camera does in an operator's words: lens, speed, direction, what it passes), start and end frames, presenter (whether she is in it), line (what she says, under 12 words, or null), and transitionOut (how it hands over to the next shot).",
  "Frames: describe each start and end frame as one concrete still: where the camera stands and looks, what is in frame left to right, the light, and where the presenter is and how big (waist-up, full length). source keyframe means a still is made for it (or use one of the given footage frames by its assetId and atMs). source previous means the shot starts exactly on the previous shot's end frame (only when the previous transition is continuous). An end may be free (the take decides) only when the next shot cuts away.",
  "Transitions: continuous means no visible cut: the next shot starts on this shot's last frame and carries the same move on (a flight through several rooms in chunks; prefer this for fly-throughs, it is the most reliable join). cut is a hard cut to another room or angle. match-cut keeps the same camera move across a cut. whip is a fast pan out of this shot and into the next, and needs direction: both shots must turn that way (a whip right needs pan-right at the end of this shot and the start of the next). speed-ramp needs a moving camera that speeds into the cut. dissolve is rare (two at most).",
  "Rules the owner enforces, all of them: (1) Variety: never two shots of roughly the same view; each shot is a different room or a clearly different point of view. Never plan one shot cut into two. (2) The transition must match the camera move: never plan a spin or whip the camera does not make. (3) A reveal is a reveal: when a shot reveals something (the chandelier, the view), say so in reveals, and frame every earlier shot so it is NOT in view (turn the presenter away from it, frame tighter, put it behind the camera). (4) The hook is the first shot: it earns the first second (the presenter's line or a striking move), and something changes inside the first second. (5) Momentum: to build speed, speed up a moving shot into a speed-ramp or carry a flight on continuously; never repeat a view to fake pace. (6) Real scale and space: the camera moves through real openings, not walls; keep the architecture consistent from shot to shot.",
  "What the video models refuse or get wrong, learned the hard way: never use the word nude in any sense (say beige or skin-tone) and do not describe revealing clothing or bodies; describe the presenter by hair, make-up, jewellery and a tailored outfit. An end frame must show the same place as its start frame, including whatever is visible through doorways, arches and windows in the start frame: a contradiction makes the model morph one room into another mid-shot. Describe one real property, the same materials in every shot.",
  "look is one sentence describing the place and light, repeated word for word in every still and take (materials, palette, time of day). outfit is what the presenter wears, word for word in every shot she is in, or null when she is not in the plan.",
  `Keep it to ${PLAN_LIMITS.shots} shots and ${PLAN_LIMITS.totalSeconds} s at most; most reels are 4 to 8 shots and 15 to 30 s.`,
  `Camera motions: ${PLAN_MOTIONS.join(", ")}. Named moves: ${MOVES.map((m) => `${m.id} (${m.blurb})`).join("; ")}.`,
].join("\n");

export type PlanInput = {
  brief: string;
  presenter: boolean;
  /** A style reference's recipe to follow (ADR 0102). */
  recipe?: string | null;
  /** Footage the planner may use as start or end frames. */
  footage: { id: string; label: string; kind: string; durationMs: number | null }[];
  /** The last attempt's continuity problems, for the one repair round. */
  problems?: PlanIssue[];
  previous?: ShotPlan;
};

export function planRequest(input: PlanInput): string {
  return [
    `Brief: ${input.brief}`,
    input.presenter ? "A presenter is available (the workspace's presenter kit): use her for the hook and wherever the brief asks." : "No presenter: plan the shots without one.",
    input.recipe ? `Follow this reference's style: ${input.recipe}` : "",
    input.footage.length ? `Footage you may use as start or end frames (assetId, what it is, length): ${input.footage.map((f) => `${f.id} (${f.label}, ${f.kind}${f.durationMs ? `, ${Math.round(f.durationMs / 100) / 10} s` : ""})`).join("; ")}.` : "No footage: every frame is a keyframe to make.",
    input.previous && input.problems?.length ? `Your last plan had these continuity problems; fix every one and keep the rest:\n${input.problems.map((p) => `- ${p.shotId}: ${p.message}`).join("\n")}\nLast plan: ${JSON.stringify(input.previous)}` : "",
  ].filter(Boolean).join("\n");
}

/** Plans the sequence: one answer, checked; with errors, one repair round with the problems listed. */
export async function planShots(workspaceId: string, input: Omit<PlanInput, "problems" | "previous">, ask: typeof structuredAnswer = structuredAnswer): Promise<{ plan: ShotPlan; issues: PlanIssue[] }> {
  const allowed = input.footage.map((f) => f.id);
  const once = async (extra: Partial<PlanInput>) => {
    const answer = await ask({
      workspaceId, instructions: SHOT_PLAN_INSTRUCTIONS, input: planRequest({ ...input, ...extra }),
      schemaName: "shot_plan", schema: SHOT_PLAN_SCHEMA(), maxOutputTokens: 12000,
    });
    const plan = parsePlannedShots(answer.json, allowed);
    return { plan, issues: planIssues(plan) };
  };
  const first = await once({});
  if (!planBlocked(first.issues)) return first;
  // The repaired plan is kept even if it still has errors: they are shown, and starting stays refused until fixed.
  return once({ previous: first.plan, problems: first.issues.filter((i) => i.level === "error") });
}

// structuredAnswer takes a plain record; core's schema is a readonly literal.
const SHOT_PLAN_SCHEMA = () => JSON.parse(JSON.stringify(SHOT_PLAN_JSON_SCHEMA)) as Record<string, unknown>;

export type ShotPlanView = {
  id: string; brief: string; status: string; waitingFor: string | null; approval: string; budgetCredits: number;
  plan: ShotPlan; state: PlanState; issues: PlanIssue[]; credits: { once: number; withRetakes: number; spent: number };
  /** Which model makes the takes, and whether the plan is still in drafts (ADR 0105). */
  engine: "veo" | "omni"; phase: "draft" | "final";
  reelId: string | null; error: string | null; createdAt: string; updatedAt: string;
};

type Row = { id: string; brief: string; status: string; waitingFor: string | null; approval: string; budgetCredits: number; plan: unknown; state: unknown; issues: unknown; reelId: string | null; error: string | null; createdAt: Date; updatedAt: Date };

export function planView(row: Row): ShotPlanView {
  const plan = shotPlanSchema.parse(row.plan);
  const state = planStateSchema.parse(row.state ?? {});
  const spent = Object.values(state.shots).reduce((sum, s) => sum + s.takes.reduce((t, take) => t + (take.assetId ? take.credits : 0), 0), 0);
  return {
    id: row.id, brief: row.brief, status: row.status, waitingFor: row.waitingFor, approval: row.approval, budgetCredits: row.budgetCredits,
    plan, state, issues: (row.issues as PlanIssue[] | null) ?? planIssues(plan), credits: { ...planCredits(plan, planEngine(state)), spent },
    engine: planEngine(state), phase: planPhase(state),
    reelId: row.reelId, error: row.error, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listShotPlans(workspaceId: string): Promise<ShotPlanView[]> {
  const rows = await prisma.shotPlan.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 30 });
  return rows.map(planView);
}

export async function getShotPlan(workspaceId: string, id: string): Promise<ShotPlanView | null> {
  const row = await prisma.shotPlan.findFirst({ where: { id, workspaceId } });
  return row ? planView(row) : null;
}

/** Plans and saves a new plan (not started: the owner reads it and its credit estimate first). */
export async function createShotPlan(user: { id: string; workspaceId: string }, input: z.infer<typeof createPlanSchema>, ask?: typeof structuredAnswer): Promise<ShotPlanView> {
  const brief = input.brief.trim().slice(0, 2000);
  if (brief.length < 10) throw new ShotPlanError("Describe the video in a sentence or two.");
  const presenter = input.presenterId ? await prisma.presenter.findFirst({ where: { id: input.presenterId, workspaceId: user.workspaceId }, select: { id: true } }) : null;
  if (input.presenterId && !presenter) throw new ShotPlanError("That presenter is not in this workspace.");
  const reference = input.referenceId ? await prisma.styleReference.findFirst({ where: { id: input.referenceId, workspaceId: user.workspaceId, status: "ready" }, select: { recipe: true } }) : null;
  if (input.referenceId && !reference) throw new ShotPlanError("That style reference is not ready in this workspace.");
  const recipe = reference ? styleRecipeSchema.safeParse(reference.recipe).data : undefined;
  const assets = input.mediaIds?.length ? await prisma.mediaAsset.findMany({
    where: { id: { in: input.mediaIds.slice(0, 20) }, kind: { in: ["IMAGE", "VIDEO"] }, ...mediaScope(user.workspaceId) },
    select: { id: true, fileName: true, room: true, kind: true, durationMs: true },
  }) : [];
  const { plan, issues } = await planShots(user.workspaceId, {
    brief, presenter: Boolean(presenter), recipe: recipe ? describeRecipe(recipe) : null,
    footage: assets.map((a) => ({ id: a.id, label: a.room ?? a.fileName, kind: a.kind, durationMs: a.durationMs })),
  }, ask);
  const engine = input.engine ?? (aiOmniConfigured() ? "omni" : "veo");
  if (engine === "omni" && !aiOmniConfigured()) throw new ShotPlanError("Gemini Omni is not set up on this deployment yet; plan with Veo.");
  const budget = input.budgetCredits ?? planCredits(plan, engine).withRetakes;
  const state = planStateSchema.parse({ engine, phase: engine === "omni" ? "draft" : "final" });
  const row = await prisma.shotPlan.create({ data: {
    workspaceId: user.workspaceId, createdById: user.id, brief, plan: plan as never, state: state as never, issues: issues as never,
    approval: input.approval ?? "storyboard", budgetCredits: Math.max(1, Math.min(500, Math.round(budget))), presenterId: presenter?.id ?? null,
  } });
  return planView(row);
}

const shotId = z.string().trim().min(1).max(40);
export const planActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), confirmCredits: z.number().int().min(0) }),
  z.object({ action: z.literal("approve_storyboard") }),
  z.object({ action: z.literal("accept_take"), shotId, aiShotId: z.string().min(1).max(64) }),
  z.object({ action: z.literal("redo"), shotId, note: z.string().trim().max(400).optional() }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("finalize") }),
  z.object({ action: z.literal("edit"), plan: z.unknown() }),
]);
export type PlanAction = z.infer<typeof planActionSchema>;

export const createPlanSchema = z.object({
  brief: z.string().trim().min(10).max(2000),
  approval: z.enum(PLAN_APPROVALS).optional(),
  presenterId: z.string().min(1).max(64).nullish(),
  referenceId: z.string().min(1).max(64).nullish(),
  mediaIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  budgetCredits: z.number().int().min(1).max(500).optional(),
  /** omni: 360p drafts first, final only once the owner confirms the draft reel (ADR 0105). Default: omni where it is set up. */
  engine: z.enum(["veo", "omni"]).optional(),
});

/**
 * One of the owner's decisions. Each one saves the new state and, where the worker has something to do, makes the plan
 * due now. Starting spends nothing by itself: it allows the worker to spend up to the budget, which the caller confirms
 * by repeating it (the same quote-then-confirm rule as a single take).
 */
export async function actOnShotPlan(workspaceId: string, id: string, act: PlanAction): Promise<ShotPlanView> {
  const row = await prisma.shotPlan.findFirst({ where: { id, workspaceId } });
  if (!row) throw new ShotPlanError("That plan is not in this workspace.");
  const view = planView(row);
  const save = async (data: Record<string, unknown>) => planView(await prisma.shotPlan.update({ where: { id: row.id }, data: { ...data, nextRunAt: new Date() } }));
  switch (act.action) {
    case "start": {
      if (planBlocked(view.issues)) throw new ShotPlanError("Fix the plan's continuity errors first (edit the plan).");
      if (act.confirmCredits !== view.budgetCredits) throw new ShotPlanError(`Starting allows up to ${view.budgetCredits} credits; confirm with that number.`);
      if (!["planned", "stopped", "failed"].includes(view.status)) throw new ShotPlanError("The plan is already running.");
      return save({ status: "running", waitingFor: null, error: null });
    }
    case "approve_storyboard":
      return save({ state: { ...view.state, storyboardApproved: true } as never, status: "running", waitingFor: null });
    case "accept_take":
      return save({ state: acceptTake(view.state, act.shotId, act.aiShotId) as never, status: "running", waitingFor: null });
    case "redo":
      return save({ state: requestRedo(view.plan, view.state, act.shotId, act.note?.slice(0, 400)).state as never, status: "running", waitingFor: null });
    case "stop":
      return save({ status: "stopped", waitingFor: null });
    case "finalize":
      // The owner confirmed the whole draft reel (ADR 0105): every shot is made again at full resolution and checked.
      if (view.waitingFor !== "draft-review") throw new ShotPlanError("Finalise once the draft reel is assembled and waiting for your review.");
      return save({ state: finalizePlan(view.plan, view.state) as never, status: "running", waitingFor: null });
    case "edit": {
      if (Object.values(view.state.shots).some((s) => s.takes.length > 0)) throw new ShotPlanError("Takes have been made; redo a shot instead of editing the plan.");
      const plan = shotPlanSchema.parse(act.plan);
      // A keyframe already made stays only if its words did not change.
      const old = new Map(view.plan.shots.map((s) => [s.id, s]));
      const kept = { ...plan, shots: plan.shots.map((s) => {
        const before = old.get(s.id);
        const keep = (end: "start" | "end") => before && before[end].description === s[end].description && before[end].assetId ? { ...s[end], assetId: before[end].assetId, atMs: before[end].atMs } : s[end];
        return { ...s, start: keep("start"), end: keep("end") };
      }) };
      return save({ plan: kept as never, issues: planIssues(kept) as never, state: { ...view.state, storyboardApproved: false } as never });
    }
  }
}

/** A stable request id for a take, so a worker that restarts mid-step asks for the same take and never pays twice. */
export function takeRequestId(planId: string, shotId: string, takeIndex: number): string {
  return uuidFrom(`shot-plan:${planId}:${shotId}:${takeIndex}`);
}

/** A UUID (version 8 layout) from a string's SHA-256, so the same input always gives the same id. */
export function uuidFrom(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Links for a plan's keyframes and takes (short-lived, so the page asks again as it follows the plan). */
export async function planMedia(workspaceId: string, view: ShotPlanView): Promise<Record<string, { url: string; thumbUrl: string | null; kind: string }>> {
  const ids = new Set<string>();
  for (const shot of view.plan.shots) for (const frame of [shot.start, shot.end]) if (frame.assetId) ids.add(frame.assetId);
  for (const s of Object.values(view.state.shots)) for (const take of s.takes) if (take.assetId) ids.add(take.assetId);
  if (!ids.size) return {};
  const rows = await prisma.mediaAsset.findMany({ where: { id: { in: [...ids] }, ...mediaScope(workspaceId) } });
  const assets = await toLibraryAssets(rows);
  return Object.fromEntries(assets.map((a) => [a.id, { url: a.url, thumbUrl: a.thumbUrl, kind: a.kind }]));
}
