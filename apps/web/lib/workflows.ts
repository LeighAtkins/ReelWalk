import { createHash } from "node:crypto";
import {
  advanceDirectorRun, aiClipCredits, checkDirectorRunStep, decideRequestIdentity, DIRECTOR_LOOP_MAX_ROUNDS, serializeAiStepMessage, stableStringify,
  timelineGeneration, type DirectorRunSnapshot,
} from "@reelwalk/core";
import { addToOutbox, prisma, RENDER_JOBS_TOPIC, type Prisma } from "@reelwalk/db";
import type { AiStepKind } from "./ai-steps";
import { ensureWorkerRunning } from "./render-capacity";
import { flushOutbox } from "./render-jobs";

/**
 * Durable AI workflows, web side (ADR 0049). Routes record a run and its
 * step with the step's queue message in one transaction (the render queue's
 * outbox), and the worker executes it under a lease. Nothing here runs a
 * model: a web restart loses no work and never repeats a paid request.
 */

/** New AI jobs go through the worker when AI_JOBS_DURABLE=1. Jobs already running in-process finish there. */
export function durableAiJobs(): boolean {
  return process.env.AI_JOBS_DURABLE === "1";
}

export function requestHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export type StartResult = { ok: true; jobId: string; runId: string; resumed: boolean } | { ok: false; status: number; message: string; reason?: string };

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "P2002";

async function queueStep(tx: Prisma.TransactionClient, step: { id: string; generation: number }) {
  await addToOutbox(tx, RENDER_JOBS_TOPIC, serializeAiStepMessage({ stepId: step.id, generation: step.generation }));
}

/** After a commit: send the message now and make sure a worker is up. Both are retried by the worker's relay if they fail here. */
async function kick() {
  await flushOutbox();
  await ensureWorkerRunning().catch((error) => console.error("Could not start a worker for an AI step; the queue keeps it", error));
}

/**
 * Starts a one-step run (Ask, autopilot polish, or a single Director review).
 * The same request id and payload resume the existing run; a changed payload
 * under the same id is refused. Returns the step id, which is the job id the
 * browser polls.
 */
export async function startSingleStepRun(input: {
  user: { id: string; workspaceId: string };
  reelId: string;
  kind: "ask" | "autopilot" | "director";
  stepKind: AiStepKind;
  requestId: string;
  payload: unknown;
  baseline: unknown;
}): Promise<StartResult> {
  const hash = requestHash(input.payload);
  const identity = { workspaceId: input.user.workspaceId, reelId: input.reelId, kind: input.kind, requestHash: hash };
  const find = () => prisma.workflowRun.findUnique({
    where: { workspaceId_kind_requestId: { workspaceId: input.user.workspaceId, kind: input.kind, requestId: input.requestId } },
    select: { id: true, workspaceId: true, reelId: true, kind: true, requestHash: true, steps: { where: { index: 0 }, select: { id: true } } },
  });
  const resume = (existing: NonNullable<Awaited<ReturnType<typeof find>>>): StartResult => {
    if (decideRequestIdentity(existing, identity) !== "resume" || !existing.steps[0]) return { ok: false, status: 409, message: "Request identity changed." };
    return { ok: true, jobId: existing.steps[0].id, runId: existing.id, resumed: true };
  };
  const existing = await find();
  if (existing) return resume(existing);
  const baselineGeneration = timelineGeneration(input.baseline);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.create({
        data: { workspaceId: input.user.workspaceId, userId: input.user.id, reelId: input.reelId, kind: input.kind, requestId: input.requestId, requestHash: hash, baselineGeneration },
        select: { id: true },
      });
      const step = await tx.workflowStep.create({
        data: { runId: run.id, index: 0, kind: input.stepKind, requestId: input.requestId, requestHash: hash, baselineGeneration, payload: input.payload as Prisma.InputJsonValue },
        select: { id: true, generation: true },
      });
      await queueStep(tx, step);
      return { runId: run.id, stepId: step.id };
    });
    await kick();
    return { ok: true, jobId: created.stepId, runId: created.runId, resumed: false };
  } catch (error) {
    // Two identical submissions raced: the loser resumes the winner's run.
    if (isUniqueViolation(error)) {
      const winner = await find();
      if (winner) return resume(winner);
    }
    throw error;
  }
}

/** Stop: persisted, so it holds whichever process or tab asks next. A step already sent to the provider still finishes and is kept. */
export async function cancelRunOfStep(workspaceId: string, stepId: string): Promise<boolean> {
  const step = await prisma.workflowStep.findFirst({ where: { id: stepId, run: { workspaceId } }, select: { runId: true } });
  if (!step) return false;
  await prisma.workflowRun.update({ where: { id: step.runId }, data: { cancelRequested: true } });
  return true;
}

// ---------------------------------------------------------------- Director "make it for me" runs

const RUN_SELECT = {
  id: true, status: true, cancelRequested: true, round: true, maxRounds: true, budgetCredits: true, spentCredits: true, reservedCredits: true,
  expectedBaseline: true, baselineGeneration: true, state: true, error: true, createdAt: true, requestHash: true, reelId: true,
  steps: { orderBy: { index: "asc" as const }, select: { id: true, index: true, status: true, error: true, result: true, baselineGeneration: true } },
} satisfies Prisma.WorkflowRunSelect;

type RunRow = Prisma.WorkflowRunGetPayload<{ select: typeof RUN_SELECT }>;

export type DirectorRunState = { message?: string; brief?: string; firstEditId?: string; awaiting?: { generationId: string; title: string; editId: string; index: number } | null };

function snapshot(run: RunRow): DirectorRunSnapshot {
  return {
    status: run.status, cancelRequested: run.cancelRequested, round: run.round, maxRounds: run.maxRounds ?? DIRECTOR_LOOP_MAX_ROUNDS,
    budgetCredits: run.budgetCredits ?? 0, spentCredits: run.spentCredits, expectedBaseline: run.expectedBaseline,
    stepActive: run.steps.some((step) => step.status === "QUEUED" || step.status === "RUNNING"),
    stepCount: run.steps.length,
  };
}

/** What the sheet shows for a run: the persisted position, spend, stop flag and steps, with review results. */
export function publicRun(run: RunRow) {
  return {
    id: run.id, status: run.status, cancelRequested: run.cancelRequested, round: run.round, maxRounds: run.maxRounds ?? DIRECTOR_LOOP_MAX_ROUNDS,
    budgetCredits: run.budgetCredits ?? 0, spentCredits: run.spentCredits, expectedBaseline: run.expectedBaseline, state: (run.state ?? {}) as DirectorRunState,
    error: run.error, steps: run.steps.map((step) => ({ id: step.id, index: step.index, status: step.status, error: step.error, result: step.status === "SUCCEEDED" ? step.result : null })),
  };
}
export type PublicDirectorRun = ReturnType<typeof publicRun>;

export async function findDirectorRun(workspaceId: string, reelId: string, runId: string) {
  return prisma.workflowRun.findFirst({ where: { id: runId, workspaceId, reelId, kind: "director-run" }, select: RUN_SELECT });
}

/** The newest run on this reel that has not finished, for the sheet to show after a reload. */
export async function activeDirectorRun(workspaceId: string, reelId: string) {
  const run = await prisma.workflowRun.findFirst({ where: { workspaceId, reelId, kind: "director-run", status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { createdAt: "desc" }, select: RUN_SELECT });
  return run ? publicRun(run) : null;
}

/** Starts a run with the studio's consent to spend up to `budgetCredits`. Idempotent by request id. */
export async function startDirectorRun(input: { user: { id: string; workspaceId: string }; reelId: string; requestId: string; brief: string; budgetCredits: number }): Promise<{ ok: true; run: PublicDirectorRun } | { ok: false; status: number; message: string }> {
  const hash = requestHash({ brief: input.brief, budgetCredits: input.budgetCredits });
  const where = { workspaceId_kind_requestId: { workspaceId: input.user.workspaceId, kind: "director-run", requestId: input.requestId } };
  const existing = await prisma.workflowRun.findUnique({ where, select: RUN_SELECT });
  if (existing) {
    if (decideRequestIdentity({ workspaceId: input.user.workspaceId, reelId: existing.reelId, kind: "director-run", requestHash: existing.requestHash }, { workspaceId: input.user.workspaceId, reelId: input.reelId, kind: "director-run", requestHash: hash }) !== "resume") return { ok: false, status: 409, message: "Run identity changed." };
    return { ok: true, run: publicRun(existing) };
  }
  const run = await prisma.workflowRun.create({
    data: {
      workspaceId: input.user.workspaceId, userId: input.user.id, reelId: input.reelId, kind: "director-run", requestId: input.requestId, requestHash: hash,
      status: "RUNNING", approvedAt: new Date(), budgetCredits: input.budgetCredits, maxRounds: DIRECTOR_LOOP_MAX_ROUNDS, state: { brief: input.brief } satisfies DirectorRunState,
    },
    select: RUN_SELECT,
  });
  return { ok: true, run: publicRun(run) };
}

/**
 * Adds the next review to a run. The run row is locked for the check so two
 * tabs cannot both add a round; the review's own request id makes a retried
 * POST resume rather than add a second review.
 */
export async function addDirectorReview(input: { user: { id: string; workspaceId: string }; reelId: string; runId: string; requestId: string; payload: unknown; baseline: unknown }): Promise<StartResult> {
  const hash = requestHash(input.payload);
  const baselineGeneration = timelineGeneration(input.baseline);
  const result = await prisma.$transaction(async (tx): Promise<StartResult> => {
    await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id = ${input.runId} FOR UPDATE`;
    const run = await tx.workflowRun.findFirst({ where: { id: input.runId, workspaceId: input.user.workspaceId, reelId: input.reelId, kind: "director-run" }, select: RUN_SELECT });
    if (!run) return { ok: false, status: 404, message: "That run is not available. Start a new one." };
    const same = await tx.workflowStep.findUnique({ where: { runId_requestId: { runId: run.id, requestId: input.requestId } }, select: { id: true, requestHash: true } });
    if (same) return same.requestHash === hash ? { ok: true, jobId: same.id, runId: run.id, resumed: true } : { ok: false, status: 409, message: "Review identity changed." };
    const check = checkDirectorRunStep(snapshot(run), baselineGeneration);
    if (!check.ok) return { ok: false, status: 409, message: check.message, reason: check.reason };
    const step = await tx.workflowStep.create({
      data: { runId: run.id, index: run.steps.length, kind: "director-review", requestId: input.requestId, requestHash: hash, baselineGeneration, payload: input.payload as Prisma.InputJsonValue },
      select: { id: true, generation: true },
    });
    if (!run.baselineGeneration) await tx.workflowRun.update({ where: { id: run.id }, data: { baselineGeneration } });
    await queueStep(tx, step);
    return { ok: true, jobId: step.id, runId: run.id, resumed: false };
  });
  if (result.ok && !result.resumed) await kick();
  return result;
}

type ReviewResult = { editId: string; timeline: unknown; baseline: unknown; plan: { shots: { title: string; durationSeconds: 4 | 8; voice?: "lipsync" | "veo" | null }[] } };

/**
 * After the sheet applied a review and started its shot: one more round, the
 * shot's credits (quoted from the stored plan, never from the browser) on the
 * run's tally, and the timeline the next review must start from.
 */
export async function advanceRun(input: { workspaceId: string; reelId: string; runId: string; stepId: string; index: number; generationId: string; applied: boolean }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id = ${input.runId} FOR UPDATE`;
    const run = await tx.workflowRun.findFirst({ where: { id: input.runId, workspaceId: input.workspaceId, reelId: input.reelId, kind: "director-run" }, select: RUN_SELECT });
    if (!run) return { ok: false as const, status: 404, message: "That run is not available." };
    const step = run.steps.find((s) => s.id === input.stepId && s.status === "SUCCEEDED");
    if (!step || step.index !== run.steps.length - 1) return { ok: false as const, status: 409, message: "That review is not the run's latest." };
    const review = step.result as unknown as ReviewResult;
    const shot = review.plan.shots[input.index];
    if (!shot) return { ok: false as const, status: 400, message: "That shot is not in the review." };
    const generation = await tx.aiGeneration.findFirst({ where: { id: input.generationId, workspaceId: input.workspaceId }, select: { id: true } });
    if (!generation) return { ok: false as const, status: 400, message: "That shot was not started." };
    const state = (run.state ?? {}) as DirectorRunState;
    const awaiting = { generationId: input.generationId, title: shot.title, editId: review.editId, index: input.index };
    // A retried report of the same shot changes nothing.
    if (state.awaiting?.generationId === input.generationId) return { ok: true as const, run: publicRun(run) };
    const next = advanceDirectorRun(snapshot(run), { credits: aiClipCredits(shot.durationSeconds, Boolean(shot.voice)), nextBaseline: timelineGeneration(input.applied ? review.timeline : review.baseline) });
    if (!next.ok) return { ok: false as const, status: 409, message: next.message };
    const updated = await tx.workflowRun.update({
      where: { id: run.id },
      data: { round: next.round, spentCredits: next.spentCredits, expectedBaseline: next.expectedBaseline, state: { ...state, firstEditId: state.firstEditId ?? review.editId, awaiting } as Prisma.InputJsonValue },
      select: RUN_SELECT,
    });
    return { ok: true as const, run: publicRun(updated) };
  });
}

/** Records where the loop is (the take arrived, the review was applied) without changing the round or spend. */
export async function noteRun(input: { workspaceId: string; reelId: string; runId: string; patch: Partial<DirectorRunState>; applied?: { stepId: string } }) {
  const run = await findDirectorRun(input.workspaceId, input.reelId, input.runId);
  if (!run) return null;
  const data: Prisma.WorkflowRunUpdateInput = { state: { ...((run.state ?? {}) as DirectorRunState), ...input.patch } as Prisma.InputJsonValue };
  if (input.applied) {
    const step = run.steps.find((s) => s.id === input.applied!.stepId && s.status === "SUCCEEDED");
    if (step) {
      const review = step.result as unknown as ReviewResult;
      data.expectedBaseline = timelineGeneration(review.timeline);
      data.state = { ...((run.state ?? {}) as DirectorRunState), ...input.patch, firstEditId: ((run.state ?? {}) as DirectorRunState).firstEditId ?? review.editId } as Prisma.InputJsonValue;
    }
  }
  return publicRun(await prisma.workflowRun.update({ where: { id: run.id }, data, select: RUN_SELECT }));
}

/** Ends a run with what really happened: finished (Opus is happy, the budget or rounds ran out), failed, or stopped by the studio. */
export async function endRun(input: { workspaceId: string; reelId: string; runId: string; outcome: "succeeded" | "failed" | "stopped"; message: string }) {
  const run = await findDirectorRun(input.workspaceId, input.reelId, input.runId);
  if (!run) return null;
  const state = { ...((run.state ?? {}) as DirectorRunState), message: input.message.slice(0, 500), awaiting: null } as Prisma.InputJsonValue;
  const active = run.steps.some((s) => s.status === "QUEUED" || s.status === "RUNNING");
  // Conditional writes: a stale tab's "finish" never overwrites a run that was stopped, already ended, or
  // still has a review going (another tab is driving it). Stop always lands on an open run.
  const where: Prisma.WorkflowRunWhereInput = input.outcome === "stopped"
    ? { id: run.id, status: { in: ["QUEUED", "RUNNING"] } }
    : { id: run.id, status: "RUNNING", cancelRequested: false, steps: { none: { status: { in: ["QUEUED", "RUNNING"] } } } };
  const data: Prisma.WorkflowRunUpdateManyMutationInput = input.outcome === "stopped"
    ? { cancelRequested: true, ...(active ? {} : { status: "FAILED", error: "Stopped by the studio.", finishedAt: new Date() }), state }
    : input.outcome === "failed"
      ? { status: "FAILED", error: input.message.slice(0, 500), finishedAt: new Date(), state }
      : { status: "SUCCEEDED", finishedAt: new Date(), state };
  const written = await prisma.workflowRun.updateMany({ where, data });
  const current = await findDirectorRun(input.workspaceId, input.reelId, input.runId);
  return current ? { run: publicRun(current), applied: written.count === 1 } : null;
}
