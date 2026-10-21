import { z } from "zod";
import { parseTimeline } from "./timeline";

/**
 * Durable AI workflows (ADR 0049): the pure rules for runs and steps that the
 * web routes and the worker share. A run is one thing the studio asked for;
 * its steps are what the worker executes, each under a lease.
 *
 * THE INVARIANT: once a step has recorded `submittedAt` (written under its
 * lease immediately before a paid provider request), it is never executed
 * again. If the lease is lost, the worker dies, or the request fails without
 * a definite answer, the step becomes UNRESOLVED. Only a person can ask
 * again, and that is a new request with a new identity.
 */

export const WORKFLOW_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "UNRESOLVED"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

const TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  // FAILED from QUEUED: stopped before it started, or dead-lettered before any attempt reached the provider.
  QUEUED: ["RUNNING", "FAILED"],
  // QUEUED from RUNNING is a retry, allowed only before submission (see canWorkflowTransition).
  RUNNING: ["SUCCEEDED", "FAILED", "UNRESOLVED", "QUEUED"],
  SUCCEEDED: [],
  FAILED: [],
  UNRESOLVED: [],
};

export function isWorkflowTerminal(status: WorkflowStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Whether a step may move from one state to another. A submitted step can never go back to QUEUED. */
export function canWorkflowTransition(from: WorkflowStatus, to: WorkflowStatus, step: { submitted: boolean } = { submitted: false }): boolean {
  if (!TRANSITIONS[from].includes(to)) return false;
  if (to === "QUEUED" && step.submitted) return false;
  if (to === "RUNNING" && step.submitted) return false;
  return true;
}

/** The queue message for a step. It travels on the render queue and points at the row, like a render job message. */
export const aiStepMessageSchema = z.object({
  type: z.literal("ai-step"),
  stepId: z.string().min(1),
  generation: z.number().int().min(1),
});
export type AiStepMessage = z.infer<typeof aiStepMessageSchema>;

export function serializeAiStepMessage(message: Omit<AiStepMessage, "type">): string {
  return JSON.stringify(aiStepMessageSchema.parse({ type: "ai-step", ...message }));
}

export function parseAiStepMessage(raw: string): AiStepMessage {
  return aiStepMessageSchema.parse(JSON.parse(raw));
}

/** Cheap check the worker's dispatcher makes before handing a delivery to the render path. */
export function isAiStepMessage(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { type?: unknown } | null;
    return Boolean(value) && typeof value === "object" && value!.type === "ai-step";
  } catch {
    return false;
  }
}

export type AiStepSnapshot = {
  status: WorkflowStatus;
  generation: number;
  heartbeatAt: Date | null;
  submittedAt: Date | null;
  cancelRequested: boolean;
};

/**
 * claim     - take the step and run it
 * discard   - duplicate or stale message, or the step is settled; delete it
 * defer     - another worker holds a fresh lease; leave the message
 * unresolve - the step was submitted to a paid provider by a worker that is gone; mark UNRESOLVED, never rerun
 * cancel    - the studio pressed Stop before the step reached the provider; mark FAILED
 */
export type AiStepDecision = "claim" | "discard" | "defer" | "unresolve" | "cancel";

export function decideAiStepDelivery(input: { step: AiStepSnapshot | null; message: Pick<AiStepMessage, "generation">; now: Date; staleAfterMs: number }): AiStepDecision {
  const { step, message, now, staleAfterMs } = input;
  if (!step || step.generation !== message.generation) return "discard";
  if (step.status === "QUEUED") {
    if (step.submittedAt) return "unresolve";
    return step.cancelRequested ? "cancel" : "claim";
  }
  if (step.status === "RUNNING") {
    const age = step.heartbeatAt ? now.getTime() - step.heartbeatAt.getTime() : Infinity;
    if (age <= staleAfterMs) return "defer";
    // The stale-lease reclaim: the same path a render job takes, except that a submitted step is not run again.
    if (step.submittedAt) return "unresolve";
    return step.cancelRequested ? "cancel" : "claim";
  }
  return "discard";
}

export type AiStepFailure = { status: "QUEUED"; retryDelaySeconds: number } | { status: "FAILED" } | { status: "UNRESOLVED" };

/**
 * What to do after an attempt threw.
 * - Never submitted: an ordinary retry with backoff, then FAILED.
 * - Submitted and the provider answered (the answer was refused afterwards): FAILED, a definite outcome.
 * - Submitted with no answer (timeout, connection drop, crash): UNRESOLVED. Never retried.
 */
export function decideAiStepFailure(input: { attempt: number; maxAttempts: number; backoffBaseSeconds: number; submitted: boolean; answered: boolean }): AiStepFailure {
  if (input.submitted) return input.answered ? { status: "FAILED" } : { status: "UNRESOLVED" };
  if (input.attempt >= input.maxAttempts) return { status: "FAILED" };
  return { status: "QUEUED", retryDelaySeconds: Math.min(900, input.backoffBaseSeconds * 2 ** Math.max(0, input.attempt - 1)) };
}

/**
 * A step's message reached the dead-letter queue: settle a row no worker settled.
 * "wait" is a step a live worker still holds: the dead letter is kept (left to
 * reappear) rather than deleted, so if that worker dies the step is settled on
 * a later receive instead of being stranded.
 */
export function decideAiStepDeadLetter(input: { step: AiStepSnapshot | null; message: Pick<AiStepMessage, "generation">; now: Date; staleAfterMs: number }): "fail" | "unresolve" | "ignore" | "wait" {
  const { step, message, now, staleAfterMs } = input;
  if (!step || step.generation !== message.generation || isWorkflowTerminal(step.status)) return "ignore";
  if (step.status === "RUNNING") {
    const age = step.heartbeatAt ? now.getTime() - step.heartbeatAt.getTime() : Infinity;
    if (age <= staleAfterMs) return "wait";
  }
  return step.submittedAt ? "unresolve" : "fail";
}

/** How long a step may sit without progress before the reaper looks at it. */
export const AI_STEP_REAP_AFTER_MS = 30 * 60_000;
/** The render queue's message retention (infra/terraform/queue.tf): past it no message for a step can exist. */
export const AI_STEP_QUEUE_RETENTION_MS = 4 * 24 * 60 * 60_000;

/**
 * The reaper, for steps whose queue message may be gone (dropped by an older
 * worker image, deleted). The outbox row is deleted once relayed, so an empty
 * outbox does not mean lost: a QUEUED step may simply be waiting in SQS behind
 * long renders, or for a worker to start.
 *
 * - QUEUED, never sent, untouched for `maxAgeMs`: "requeue", a fresh message
 *   (the claim is conditional, so a duplicate is harmless). Only once the step
 *   is older than the queue's retention, when no message for it can still
 *   exist, is it "fail".
 * - RUNNING with a heartbeat silent for `maxAgeMs` (far past the stale and
 *   visibility windows, so a live message would have reclaimed it): "fail" if
 *   never sent, "unresolve" if sent.
 */
export function decideAiStepReap(
  step: { status: WorkflowStatus; createdAt: Date; updatedAt: Date; heartbeatAt: Date | null; submittedAt: Date | null; outboxPending: boolean },
  now: Date,
  options: { maxAgeMs?: number; retentionMs?: number } = {},
): "keep" | "requeue" | "fail" | "unresolve" {
  const maxAgeMs = options.maxAgeMs ?? AI_STEP_REAP_AFTER_MS;
  const retentionMs = options.retentionMs ?? AI_STEP_QUEUE_RETENTION_MS;
  if (step.outboxPending || isWorkflowTerminal(step.status)) return "keep";
  if (step.status === "QUEUED") {
    if (step.submittedAt) return "unresolve";
    if (now.getTime() - step.updatedAt.getTime() <= maxAgeMs) return "keep";
    return now.getTime() - step.createdAt.getTime() > retentionMs ? "fail" : "requeue";
  }
  const last = step.heartbeatAt ?? step.updatedAt;
  if (now.getTime() - last.getTime() <= maxAgeMs) return "keep";
  return step.submittedAt ? "unresolve" : "fail";
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;

/** JSON with sorted keys, so the same request always hashes the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export type RequestIdentity = { workspaceId: string; reelId: string | null; kind: string; requestHash: string };

/**
 * A request id is the browser's promise that two submissions are the same
 * request. The same id and payload resume the existing run (a retried POST
 * never starts a second paid call); the same id with anything else changed is
 * refused rather than silently reusing or replacing the run.
 */
export function decideRequestIdentity(existing: RequestIdentity | null, incoming: RequestIdentity): "create" | "resume" | "conflict" {
  if (!existing) return "create";
  const same = existing.workspaceId === incoming.workspaceId && existing.reelId === incoming.reelId && existing.kind === incoming.kind && existing.requestHash === incoming.requestHash;
  return same ? "resume" : "conflict";
}

/** 53-bit string hash (cyrb53), the same in the browser and on the server. */
function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The generation of a timeline document: a token that changes whenever the
 * edit changes. Parsed first, so field order and defaults do not count. A
 * proposal carries the generation it was made from; it may be applied only
 * to a timeline with the same generation.
 */
export function timelineGeneration(timeline: unknown): string {
  let value: unknown;
  try { value = parseTimeline(timeline); } catch { value = timeline; }
  const text = stableStringify(value) ?? "null";
  return `tg1-${cyrb53(text)}-${cyrb53(text, 1)}-${text.length.toString(36)}`;
}

/** Whether a proposal made from `baselineGeneration` may be applied to the editor's `current` timeline. */
export function baselineMatches(current: unknown, baselineGeneration: string | null | undefined): boolean {
  return Boolean(baselineGeneration) && timelineGeneration(current) === baselineGeneration;
}

/** What /api/ai-jobs/<id> answers for a durable step: persisted state only, never a judgement by age. */
export type AiJobPoll =
  | { status: "QUEUED" | "RUNNING"; durable: true }
  | { status: "DONE"; durable: true; result: unknown }
  | { status: "FAILED"; durable: true; error: string }
  | { status: "UNRESOLVED"; durable: true; error: string };

export const UNRESOLVED_MESSAGE = "ReelWalk could not confirm whether this request reached the AI service, so it was not sent again. Nothing was changed. Ask again if you still want it.";

export function pollAnswer(step: { status: WorkflowStatus; result: unknown; error: string | null }): AiJobPoll {
  switch (step.status) {
    case "SUCCEEDED": return { status: "DONE", durable: true, result: step.result };
    case "FAILED": return { status: "FAILED", durable: true, error: step.error ?? "That did not work. Try again." };
    case "UNRESOLVED": return { status: "UNRESOLVED", durable: true, error: step.error ?? UNRESOLVED_MESSAGE };
    default: return { status: step.status, durable: true };
  }
}

/** A Director "make it for me" run as the server stores it (ADR 0037 loop state, ADR 0049 persistence). */
export type DirectorRunSnapshot = {
  status: WorkflowStatus;
  cancelRequested: boolean;
  round: number;
  maxRounds: number;
  budgetCredits: number;
  spentCredits: number;
  /** The generation the next review must start from: the last review's proposed timeline once applied. Null before the first review. */
  expectedBaseline: string | null;
  /** True while one of the run's steps is queued or running. */
  stepActive: boolean;
  /** How many reviews the run has. Round r has at most one: reviews <= round + 1. */
  stepCount: number;
};

export type DirectorRunCheck = { ok: true } | { ok: false; reason: "stopped" | "finished" | "busy" | "reviewed" | "baseline-mismatch" | "rounds"; message: string };

/** Whether another review may be added to a run, starting from a timeline with `baseline` generation. */
export function checkDirectorRunStep(run: DirectorRunSnapshot, baseline: string): DirectorRunCheck {
  if (run.cancelRequested) return { ok: false, reason: "stopped", message: "This run was stopped. Start a new one to continue." };
  if (isWorkflowTerminal(run.status)) return { ok: false, reason: "finished", message: "This run has finished. Start a new one to continue." };
  if (run.stepActive) return { ok: false, reason: "busy", message: "Opus is still reviewing the last round." };
  // Another tab may already have reviewed this round: one review per round, the next waits for a shot.
  if (run.stepCount > run.round) return { ok: false, reason: "reviewed", message: "This round has already been reviewed." };
  // Round r reviews after r shots were made; the first review is round 0.
  if (run.round > run.maxRounds) return { ok: false, reason: "rounds", message: `This run has used all ${run.maxRounds} rounds.` };
  if (run.expectedBaseline && run.expectedBaseline !== baseline) return { ok: false, reason: "baseline-mismatch", message: "The timeline changed while the run was going, so it stopped. Start a new run from the current edit." };
  return { ok: true };
}

/**
 * Records a shot started by the run: one more round, its credits committed.
 * Refuses a shot the remaining budget cannot cover (the approval route
 * enforces the same budget against the credit ledger; this keeps the run's
 * own tally honest and survives reloads).
 */
export function advanceDirectorRun(run: DirectorRunSnapshot, shot: { credits: number; nextBaseline: string }): { ok: true; round: number; spentCredits: number; expectedBaseline: string } | { ok: false; message: string } {
  if (run.cancelRequested || isWorkflowTerminal(run.status)) return { ok: false, message: "This run was stopped." };
  if (run.round >= run.maxRounds) return { ok: false, message: `This run has used all ${run.maxRounds} rounds.` };
  if (!Number.isInteger(shot.credits) || shot.credits < 1) return { ok: false, message: "That shot has no credit quote." };
  if (run.spentCredits + shot.credits > run.budgetCredits) return { ok: false, message: "That shot would go past the run's budget." };
  return { ok: true, round: run.round + 1, spentCredits: run.spentCredits + shot.credits, expectedBaseline: shot.nextBaseline };
}
