import {
  decideAiStepDeadLetter,
  decideAiStepDelivery,
  decideAiStepFailure,
  decideAiStepReap,
  serializeAiStepMessage,
  AI_STEP_REAP_AFTER_MS,
  parseAiStepMessage,
  UNRESOLVED_MESSAGE,
  type AiStepMessage,
  type AiStepSnapshot,
  type WorkflowStatus,
} from "@reelwalk/core";
import { addToOutbox, RENDER_JOBS_TOPIC, type Prisma, type PrismaClient } from "@reelwalk/db";
import type { Delivery, Outcome } from "./handler";
import { abortAfter, AttemptStopped, createAttemptScope, DEFAULT_GRACE_MS, linkAbort, runAttempt } from "./lifecycle";

/**
 * Durable AI steps (ADR 0049): Ask, autopilot polish and Director reviews,
 * executed by the worker with the same lease, attempt, conditional publish
 * and dead-letter machinery as renders (ADR 0045). The messages travel on the
 * render queue; handler.ts hands them here.
 *
 * The invariant this module enforces: a step is marked submitted, under its
 * lease, before any paid provider request, and a submitted step is never run
 * again. Losing it (crash, timeout, lost connection) makes it UNRESOLVED.
 */

/** "music-analysis" (ADR 0066) decodes a track with ffmpeg: it runs only in the worker and never calls a paid provider. */
export type AiStepKind = "ask" | "autopilot" | "director-review" | "music-analysis";

export type ClaimedStep = {
  id: string;
  runId: string;
  kind: AiStepKind;
  generation: number;
  attempt: number;
  payload: unknown;
  reelId: string;
  user: { id: string; workspaceId: string };
};

/** This run's hold on a step: written by the claim, required by every later write. */
export type StepLease = { stepId: string; generation: number; attempt: number };

export interface AiStepStore {
  snapshot(stepId: string): Promise<AiStepSnapshot | null>;
  /** QUEUED (or stale RUNNING, never submitted) -> RUNNING. Null when another worker got there first. */
  /**
   * QUEUED (or stale RUNNING, never submitted) -> RUNNING, incrementing the step's attempt counter; the
   * returned step carries the new attempt (not the SQS receive count, which restarts on a hand-back).
   * Null when another worker got there first.
   */
  claim(message: AiStepMessage, staleBefore: Date): Promise<ClaimedStep | null>;
  heartbeat(lease: StepLease): Promise<void>;
  /**
   * Records the paid submission. False when the lease was lost or the run was
   * stopped; then nothing may be sent. `cancelled` tells the two apart.
   */
  markSubmitted(lease: StepLease): Promise<{ ok: true } | { ok: false; cancelled: boolean }>;
  /** Publishes the result; false when the lease was lost, in which case nothing was written. */
  succeed(lease: StepLease, result: unknown): Promise<boolean>;
  /** Back to QUEUED for a retry. Only for a step never submitted. */
  requeue(lease: StepLease, error: string): Promise<void>;
  fail(lease: StepLease, error: string): Promise<void>;
  unresolve(lease: StepLease, error: string): Promise<void>;
  /** Settles a step no live worker holds (stale lease, Stop before start, dead letter). Conditional on the lease being stale. */
  settleAbandoned(message: AiStepMessage, status: "FAILED" | "UNRESOLVED", error: string, staleBefore: Date): Promise<void>;
  /** The reaper (decideAiStepReap): re-enqueues old queued steps, settles ones no message can reach. Returns how many. */
  reapAbandoned(now: Date, options?: { maxAgeMs?: number; retentionMs?: number }): Promise<{ requeued: number; failed: number; unresolved: number }>;
}

/** Called around every paid provider request the step makes (apps/web/lib/provider-gate.ts). */
export type ProviderGate = { beforeRequest(): Promise<void>; answered(): void; signal?: AbortSignal };

export type AiStepExecutor = {
  run(step: ClaimedStep, gate: ProviderGate): Promise<unknown>;
  /** The words the studio sees for a failed step. */
  describeError(step: ClaimedStep, error: unknown): string;
};

export type AiStepDeps = {
  store: AiStepStore;
  executor: AiStepExecutor;
  config: {
    maxAttempts: number;
    visibilitySeconds: number;
    heartbeatSeconds: number;
    staleSeconds: number;
    retryBackoffSeconds: number;
    /** The most one AI attempt may take. Past it a submitted step is UNRESOLVED, an unsubmitted one retried. */
    aiStepTimeoutSeconds?: number;
    /** How long a stopped attempt may take to unwind (ADR 0050). */
    abortGraceSeconds?: number;
    /** After SIGTERM, how long a running step may keep going before it is stopped. */
    shutdownDrainSeconds?: number;
  };
  /** Aborted when the worker is stopping (SIGTERM): an unsent step is handed back, a sent one is never re-run. */
  shutdown?: AbortSignal;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
};

class LeaseLost extends Error {
  constructor() { super("The step is no longer this worker's."); }
}
class Stopped extends Error {
  constructor() { super("Stopped before it was sent."); }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

/** Processes one AI step delivery from the render queue. Returns the same outcomes as a render delivery. */
export async function handleAiStepDelivery(deps: AiStepDeps, delivery: Delivery): Promise<Outcome> {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, error) => (error ? console.error(message, error) : console.log(message)));

  let message: AiStepMessage;
  try {
    message = parseAiStepMessage(delivery.body);
  } catch (error) {
    log("Unparseable AI step message, leaving it for the dead-letter queue", error);
    return "poison";
  }
  const tag = `[ai-step ${message.stepId}]`;
  const staleAfterMs = config.staleSeconds * 1000;
  const staleBefore = () => new Date(now().getTime() - staleAfterMs);

  const decision = decideAiStepDelivery({ step: await store.snapshot(message.stepId), message, now: now(), staleAfterMs });
  if (decision === "discard") {
    await delivery.delete();
    return "discarded";
  }
  if (decision === "defer") {
    await delivery.extend(config.visibilitySeconds).catch((error) => log(`${tag} could not extend visibility`, error));
    return "deferred";
  }
  if (decision === "unresolve") {
    // Its worker sent the paid request and then went away. Running it again could charge twice.
    log(`${tag} lease went stale after the provider request was sent; marking unresolved, not retrying`);
    await store.settleAbandoned(message, "UNRESOLVED", UNRESOLVED_MESSAGE, staleBefore());
    await delivery.delete();
    return "failed";
  }
  if (decision === "cancel") {
    log(`${tag} stopped before it started`);
    await store.settleAbandoned(message, "FAILED", "Stopped. Nothing was sent to the AI service.", staleBefore());
    await delivery.delete();
    return "failed";
  }

  const step = await store.claim(message, staleBefore());
  if (!step) return "deferred";
  const lease: StepLease = { stepId: step.id, generation: step.generation, attempt: step.attempt };
  log(`${tag} claimed (${step.kind}), attempt ${step.attempt} (delivery ${delivery.receiveCount}/${config.maxAttempts})`);

  const heartbeat = setInterval(() => {
    delivery.extend(config.visibilitySeconds).catch((error) => log(`${tag} could not extend visibility`, error));
    store.heartbeat(lease).catch((error) => log(`${tag} could not write heartbeat`, error));
  }, config.heartbeatSeconds * 1000);
  // The attempt runs in a scope (ADR 0050): the deadline and a worker shutdown abort its signal, which
  // cancels the step's provider requests in flight and refuses new ones (the gate), and runAttempt settles
  // only after the step has unwound or its grace ran out.
  const scope = createAttemptScope({ graceMs: (config.abortGraceSeconds ?? DEFAULT_GRACE_MS / 1000) * 1000, log });
  const timeoutMs = (config.aiStepTimeoutSeconds ?? 10 * 60) * 1000;
  const cancelDeadline = abortAfter(scope, timeoutMs, () => new AttemptStopped(`AI step exceeded ${timeoutMs < 60_000 ? `${timeoutMs / 1000} seconds` : `${Math.round(timeoutMs / 60_000)} minutes`}`, "deadline"));
  const unlinkShutdown = linkAbort(deps.shutdown, scope, () => new AttemptStopped("The worker stopped during the AI step", "shutdown"), (config.shutdownDrainSeconds ?? 0) * 1000);

  // The first provider request records the submission (once, even for parallel requests); every request
  // stays "in flight" until its response arrives. A refusal is remembered, because step code may catch
  // and soften errors from the provider call it wraps.
  let submission: Promise<void> | null = null, submitted = false, inflight = 0;
  let refusal: LeaseLost | Stopped | null = null;
  const gate: ProviderGate = {
    beforeRequest: async () => {
      if (refusal) throw refusal;
      submission ??= store.markSubmitted(lease).then((marked) => {
        if (!marked.ok) throw (refusal = marked.cancelled ? new Stopped() : new LeaseLost());
        submitted = true;
      });
      await submission;
      inflight += 1;
    },
    answered: () => { inflight = Math.max(0, inflight - 1); },
    signal: scope.signal,
  };
  try {
    const result = await runAttempt(scope, () => deps.executor.run(step, gate)).finally(() => clearInterval(heartbeat));
    if (refusal) throw refusal;
    // Step code turns a lost provider answer into a polite { ok: false } (askForChange does); with a sent
    // request still unanswered that is not a definite outcome, so it is settled as unresolved.
    if (inflight > 0 && (result as { ok?: unknown } | null)?.ok === false) throw new Error("A provider request was sent and got no answer.");
    if (!(await store.succeed(lease, result))) {
      log(`${tag} finished, but the step is no longer this worker's; result not published`);
      return "discarded";
    }
    await delivery.delete();
    log(`${tag} succeeded`);
    return "succeeded";
  } catch (thrown) {
    const error: unknown = refusal ?? thrown;
    if (error instanceof LeaseLost) {
      log(`${tag} lost its lease before sending anything; leaving it to the worker that holds it`);
      return "discarded";
    }
    if (error instanceof Stopped) {
      await store.fail(lease, "Stopped. Nothing was sent to the AI service.");
      await delivery.delete();
      return "failed";
    }
    if (error instanceof AttemptStopped && error.why === "shutdown" && !submitted) {
      // Nothing was sent: hand the step straight back for another worker, without spending a delivery.
      log(`${tag} attempt ${step.attempt} interrupted by shutdown before sending anything, handing it back`);
      await store.requeue(lease, errorText(error));
      if (!delivery.handBack) {
        await delivery.extend(0);
        return "interrupted";
      }
      try {
        await delivery.handBack();
      } catch (handBackError) {
        log(`${tag} could not hand the message back; making it visible again instead`, handBackError);
        await delivery.extend(0);
      }
      return "interrupted";
    }
    // A shutdown after sending is like any other loss after sending: never re-run (the invariant below).
    const failure = decideAiStepFailure({ attempt: delivery.receiveCount, maxAttempts: config.maxAttempts, backoffBaseSeconds: config.retryBackoffSeconds, submitted, answered: inflight === 0 });
    if (failure.status === "QUEUED") {
      log(`${tag} attempt ${step.attempt} failed before reaching the provider, retrying in ${failure.retryDelaySeconds}s`, error);
      await store.requeue(lease, errorText(error));
      await delivery.extend(failure.retryDelaySeconds);
      return "retrying";
    }
    if (failure.status === "UNRESOLVED") {
      log(`${tag} failed after the provider request was sent, without an answer; unresolved, not retrying`, error);
      await store.unresolve(lease, UNRESOLVED_MESSAGE);
    } else {
      log(`${tag} failed`, error);
      await store.fail(lease, deps.executor.describeError(step, error));
    }
    await delivery.delete();
    return "failed";
  } finally {
    clearInterval(heartbeat);
    cancelDeadline();
    unlinkShutdown();
  }
}

/** A step's message reached the dead-letter queue: settle what no worker settled, by whether it was submitted. */
export async function handleAiStepDeadLetter(
  deps: Pick<AiStepDeps, "store" | "log" | "now"> & { config: Pick<AiStepDeps["config"], "staleSeconds"> },
  delivery: Pick<Delivery, "body" | "delete">,
): Promise<"failed" | "ignored" | "poison"> {
  const log = deps.log ?? ((message, error) => (error ? console.error(message, error) : console.log(message)));
  const now = deps.now ?? (() => new Date());
  let message: AiStepMessage;
  try {
    message = parseAiStepMessage(delivery.body);
  } catch (error) {
    log(`Dropping unparseable AI step dead letter: ${delivery.body.slice(0, 200)}`, error);
    await delivery.delete();
    return "poison";
  }
  const staleAfterMs = deps.config.staleSeconds * 1000;
  const decision = decideAiStepDeadLetter({ step: await deps.store.snapshot(message.stepId), message, now: now(), staleAfterMs });
  if (decision === "wait") {
    // A live worker holds the step. Keep the dead letter (it reappears after its visibility timeout) so the
    // step is settled from here if that worker dies, instead of deleting the last message pointing at it.
    log(`[ai-step ${message.stepId}] dead letter for a step a worker still holds; keeping it`);
    return "ignored";
  }
  if (decision !== "ignore") {
    log(`[ai-step ${message.stepId}] dead-lettered while unsettled, marking ${decision === "unresolve" ? "unresolved" : "failed"}`);
    const staleBefore = new Date(now().getTime() - staleAfterMs);
    if (decision === "unresolve") await deps.store.settleAbandoned(message, "UNRESOLVED", UNRESOLVED_MESSAGE, staleBefore);
    else await deps.store.settleAbandoned(message, "FAILED", "The AI request could not be started. Nothing was sent; try again.", staleBefore);
  }
  await delivery.delete();
  return decision === "ignore" ? "ignored" : "failed";
}

/** Removes the review frame images from a stored payload once the step has ended (they are only needed to run it). */
export function stripImages(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { evidence?: unknown }).evidence)) return payload;
  const value = payload as { evidence: Record<string, unknown>[] };
  return { ...value, evidence: value.evidence.map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "image"))) };
}

/**
 * Prisma-backed AiStepStore. Every write is one conditional UPDATE on the
 * lease (step, generation, attempt, RUNNING), as in the render job store.
 */
export function createAiStepStore(prisma: PrismaClient): AiStepStore {
  const running = (lease: StepLease) => ({ id: lease.stepId, generation: lease.generation, attempt: lease.attempt, status: "RUNNING" as const });

  /** One-step runs mirror their step. A Director run stays open for the sheet, unless the studio stopped it. */
  async function settleRun(tx: Prisma.TransactionClient, stepId: string, status: WorkflowStatus, error: string | null) {
    const step = await tx.workflowStep.findUnique({ where: { id: stepId }, select: { run: { select: { id: true, kind: true, cancelRequested: true } } } });
    if (!step) return;
    const finishedAt = new Date();
    if (step.run.kind !== "director-run") await tx.workflowRun.update({ where: { id: step.run.id }, data: { status, error, finishedAt } });
    else if (step.run.cancelRequested) await tx.workflowRun.updateMany({ where: { id: step.run.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", error: "Stopped by the studio.", finishedAt } });
  }

  async function finish(lease: StepLease, status: "SUCCEEDED" | "FAILED" | "UNRESOLVED", data: { result?: unknown; error: string | null }, where: Prisma.WorkflowStepWhereInput = running(lease)): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.workflowStep.findFirst({ where, select: { payload: true } });
      if (!current) return false;
      const done = await tx.workflowStep.updateMany({
        where,
        data: { status, error: data.error, finishedAt: new Date(), payload: stripImages(current.payload) as Prisma.InputJsonValue, ...(data.result === undefined ? {} : { result: JSON.parse(JSON.stringify(data.result)) as Prisma.InputJsonValue }) },
      });
      if (done.count === 0) return false;
      await settleRun(tx, lease.stepId, status, data.error);
      return true;
    });
  }

  return {
    async snapshot(stepId) {
      const step = await prisma.workflowStep.findUnique({ where: { id: stepId }, select: { status: true, generation: true, heartbeatAt: true, submittedAt: true, run: { select: { cancelRequested: true } } } });
      return step ? { status: step.status, generation: step.generation, heartbeatAt: step.heartbeatAt, submittedAt: step.submittedAt, cancelRequested: step.run.cancelRequested } : null;
    },

    async claim(message, staleBefore) {
      const now = new Date();
      const claimed = await prisma.workflowStep.updateMany({
        where: {
          id: message.stepId,
          generation: message.generation,
          // Never a submitted step: that one is UNRESOLVED, not re-run.
          submittedAt: null,
          run: { cancelRequested: false },
          OR: [{ status: "QUEUED" }, { status: "RUNNING", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }] }],
        },
        data: { status: "RUNNING", attempt: { increment: 1 }, startedAt: now, heartbeatAt: now },
      });
      if (claimed.count === 0) return null;
      const step = await prisma.workflowStep.findUniqueOrThrow({ where: { id: message.stepId }, include: { run: { select: { id: true, kind: true, userId: true, workspaceId: true, reelId: true } } } });
      if (step.run.kind !== "director-run") await prisma.workflowRun.updateMany({ where: { id: step.run.id, status: "QUEUED" }, data: { status: "RUNNING" } });
      return {
        id: step.id, runId: step.run.id, kind: step.kind as AiStepKind, generation: step.generation, attempt: step.attempt, payload: step.payload,
        reelId: step.run.reelId ?? "", user: { id: step.run.userId, workspaceId: step.run.workspaceId },
      };
    },

    async heartbeat(lease) {
      await prisma.workflowStep.updateMany({ where: running(lease), data: { heartbeatAt: new Date() } });
    },

    async markSubmitted(lease) {
      const marked = await prisma.workflowStep.updateMany({ where: { ...running(lease), submittedAt: null, run: { cancelRequested: false } }, data: { submittedAt: new Date(), heartbeatAt: new Date() } });
      if (marked.count === 1) return { ok: true };
      const step = await prisma.workflowStep.findUnique({ where: { id: lease.stepId }, select: { run: { select: { cancelRequested: true } } } });
      return { ok: false, cancelled: Boolean(step?.run.cancelRequested) };
    },

    async succeed(lease, result) {
      return finish(lease, "SUCCEEDED", { result, error: null });
    },

    async requeue(lease, error) {
      await prisma.workflowStep.updateMany({ where: { ...running(lease), submittedAt: null }, data: { status: "QUEUED", error, heartbeatAt: null } });
    },

    async fail(lease, error) {
      await finish(lease, "FAILED", { error });
    },

    async unresolve(lease, error) {
      await finish(lease, "UNRESOLVED", { error });
    },

    async reapAbandoned(now, options = {}) {
      const maxAgeMs = options.maxAgeMs ?? AI_STEP_REAP_AFTER_MS;
      const before = new Date(now.getTime() - maxAgeMs);
      const candidates = await prisma.workflowStep.findMany({
        where: { OR: [{ status: "QUEUED", updatedAt: { lt: before } }, { status: "RUNNING", OR: [{ heartbeatAt: null, updatedAt: { lt: before } }, { heartbeatAt: { lt: before } }] }] },
        select: { id: true, status: true, generation: true, createdAt: true, updatedAt: true, heartbeatAt: true, submittedAt: true },
        take: 50,
      });
      const counts = { requeued: 0, failed: 0, unresolved: 0 };
      for (const step of candidates) {
        // A message still waiting in the outbox will be relayed; leave that step to its delivery.
        const outboxPending = (await prisma.outboxMessage.count({ where: { body: { contains: `"stepId":"${step.id}"` } } })) > 0;
        const decision = decideAiStepReap({ ...step, outboxPending }, now, options);
        if (decision === "keep") continue;
        if (decision === "requeue") {
          // A fresh message, in case the old one is gone. Touching the row restarts its clock, so this happens
          // at most once per maxAgeMs; if the old message is still queued, the second delivery is discarded.
          const requeued = await prisma.$transaction(async (tx) => {
            const touched = await tx.workflowStep.updateMany({ where: { id: step.id, generation: step.generation, status: "QUEUED", submittedAt: null, updatedAt: step.updatedAt }, data: { updatedAt: now } });
            if (touched.count === 0) return false;
            await addToOutbox(tx, RENDER_JOBS_TOPIC, serializeAiStepMessage({ stepId: step.id, generation: step.generation }));
            return true;
          });
          if (requeued) counts.requeued += 1;
          continue;
        }
        const status = decision === "unresolve" ? "UNRESOLVED" : "FAILED";
        const settled = await finish({ stepId: step.id, generation: step.generation, attempt: -1 }, status, {
          error: status === "UNRESOLVED" ? UNRESOLVED_MESSAGE : "The AI request was lost before it started. Nothing was sent; try again.",
        }, {
          id: step.id, generation: step.generation, status: step.status, updatedAt: step.updatedAt,
          ...(status === "FAILED" ? { submittedAt: null } : {}),
        });
        if (settled) counts[status === "UNRESOLVED" ? "unresolved" : "failed"] += 1;
      }
      return counts;
    },

    async settleAbandoned(message, status, error, staleBefore) {
      const lease = { stepId: message.stepId, generation: message.generation, attempt: -1 };
      await finish(lease, status, { error }, {
        id: message.stepId,
        generation: message.generation,
        ...(status === "FAILED" ? { submittedAt: null } : {}),
        OR: [{ status: "QUEUED" }, { status: "RUNNING", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }] }],
      });
    },
  };
}
