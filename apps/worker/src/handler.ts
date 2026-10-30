import {
  decideDelivery,
  decideFailure,
  isAiStepMessage,
  parseRenderJobMessage,
  shouldFailFromDeadLetter,
  type JobSnapshot,
  type RenderJobMessage,
} from "@reelwalk/core";
import { abortAfter, AttemptStopped, createAttemptScope, DEFAULT_GRACE_MS, linkAbort, runAttempt, type AttemptScope } from "./lifecycle";
import { handleAiStepDeadLetter, handleAiStepDelivery, type AiStepDeps } from "./ai-jobs";

export type ClaimedJob = {
  id: string;
  generation: number;
  /** The attempt this claim wrote (a per-job counter the claim increments), part of the lease and of the output's key. */
  attempt: number;
  kind: "TEMPLATE" | "EDITOR" | "REEL" | "PREVIEW" | "STORY";
  caption: string | null;
  payload: unknown;
  inputKey: string | null;
  brand: string | null;
  /** For PREVIEW jobs: the upload being transcoded and where its rendition goes (a key of this run's own). */
  mediaAssetId?: string | null;
  previewKey?: string | null;
  /** Shutdown hand-backs of this generation so far (ADR 0094); past the budget a shutdown spends an attempt. */
  interruptions?: number;
};

/**
 * What a preview run made for its asset. Published by `succeed`, in the same
 * transaction as the job's success, so a run that lost its job never points
 * the asset at its files (ADR 0094).
 */
export type AssetUpdate = { id: string; previewKey: string; thumbKey?: string | null; transcript?: unknown };

export type RenderResult = { objectKey: string; contentType: string; sizeBytes: number; asset?: AssetUpdate };

/**
 * This run's hold on a job: the message's job and generation plus the attempt
 * the claim wrote. A worker that was declared stale and resumes later still
 * holds the same job and generation, so the attempt is what tells its writes
 * from the replacement's.
 */
export type Lease = RenderJobMessage & { attempt: number };

/** Database side of a job. Every write is conditional on the job still being this run's (its lease). */
export interface JobStore {
  snapshot(jobId: string): Promise<JobSnapshot | null>;
  /**
   * QUEUED (or stale RUNNING) -> RUNNING, incrementing the job's attempt
   * counter; the returned job carries the new attempt. Not the SQS receive
   * count: a message handed back on shutdown is re-sent and its count starts
   * again, and the attempt must still never repeat (it names the output).
   * Returns null if another worker got there first.
   */
  claim(message: RenderJobMessage, staleBefore: Date): Promise<ClaimedJob | null>;
  /** Keeps the job this run's; false when the lease is gone (the job was moved or taken over). */
  heartbeat(lease: Lease, progress?: number): Promise<boolean>;
  /** Publishes the output (and a preview's asset update) and marks the job done; false when the lease was lost, in which case nothing was written. */
  succeed(lease: Lease, output: RenderResult): Promise<boolean>;
  requeue(lease: Lease, error: string): Promise<void>;
  /** Requeues after a shutdown and counts the interruption. */
  interrupt(lease: Lease, error: string): Promise<void>;
  fail(lease: Lease, error: string): Promise<void>;
  /** Marks a job FAILED without holding a lease: the dead-letter path, for a job whose every worker died before writing an error. */
  failAbandoned(message: RenderJobMessage, error: string): Promise<void>;
}

/** One received queue message. */
export interface Delivery {
  body: string;
  /** SQS ApproximateReceiveCount: 1 on first delivery. */
  receiveCount: number;
  /** Hide the message for `seconds` more, counted from now. */
  extend(seconds: number): Promise<void>;
  delete(): Promise<void>;
  /**
   * Sends a fresh copy of the message (receive count 1) and deletes this one:
   * hands a job back without spending one of its attempts. Optional; without
   * it a hand-back makes the message visible again, which does spend one.
   */
  handBack?(): Promise<void>;
}

export type HandlerDeps = {
  store: JobStore;
  /** Renders the job. Everything long-running takes `scope.signal` or is owned by `scope` (ADR 0050). */
  render: (job: ClaimedJob, onProgress: (percent: number) => void, scope: AttemptScope) => Promise<RenderResult>;
  config: {
    maxAttempts: number;
    visibilitySeconds: number;
    heartbeatSeconds: number;
    staleSeconds: number;
    retryBackoffSeconds: number;
    /** The most one attempt may take; past it the attempt fails and is retried or dead-lettered, instead of heartbeating forever. */
    jobTimeoutSeconds?: number;
    /** How long a stopped attempt may take to unwind, and then to release what it holds (each). */
    abortGraceSeconds?: number;
    /** After SIGTERM, how long a running render may keep going before it is stopped (0: stop at once). */
    shutdownDrainSeconds?: number;
    /**
     * Shutdown hand-backs a generation gets without spending an attempt (ADR 0094). Past it a shutdown
     * counts as a failed attempt, so a job interrupted again and again (Spot) ends instead of looping.
     */
    maxInterruptions?: number;
  };
  /** Aborted when the worker is stopping (SIGTERM): the attempt is stopped and the job handed back. */
  shutdown?: AbortSignal;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Durable AI steps share the render queue (ADR 0049); without these deps their messages are left for the DLQ. */
  aiSteps?: AiStepDeps;
};

export type Outcome = "succeeded" | "retrying" | "interrupted" | "failed" | "discarded" | "deferred" | "poison" | "handed-off";

/** The attempt stopped because a heartbeat found the job no longer this run's (moved to the cloud, or taken over). */
const LEASE_LOST = "The job was moved to another worker";

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

/**
 * Processes one delivery from the render queue. The message is deleted only
 * when the job is finished or the message is known to be redundant; in every
 * other case it is left for SQS to redeliver or dead-letter.
 */
export async function handleDelivery(deps: HandlerDeps, delivery: Delivery): Promise<Outcome> {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, error) => (error ? console.error(message, error) : console.log(message)));

  if (deps.aiSteps && isAiStepMessage(delivery.body)) return handleAiStepDelivery({ ...deps.aiSteps, shutdown: deps.shutdown }, delivery);
  let message: RenderJobMessage;
  try {
    message = parseRenderJobMessage(delivery.body);
  } catch (error) {
    // Unreadable payload: never deletable by us, so it ends up in the DLQ for a human.
    log("Unparseable queue message, leaving it for the dead-letter queue", error);
    return "poison";
  }

  const staleAfterMs = config.staleSeconds * 1000;
  const decision = decideDelivery({ job: await store.snapshot(message.jobId), message, now: now(), staleAfterMs });
  if (decision === "discard") {
    log(`[${message.jobId}] duplicate or stale message, deleting`);
    await delivery.delete();
    return "discarded";
  }
  if (decision === "defer") {
    // A duplicate of a message another worker holds. Hide it for a full
    // visibility period so it is not received (and its receive count spent)
    // again before that worker's heartbeat could possibly have gone stale.
    log(`[${message.jobId}] another worker is rendering, leaving the message`);
    await delivery.extend(config.visibilitySeconds).catch((error) => log(`[${message.jobId}] could not extend visibility`, error));
    return "deferred";
  }

  const job = await store.claim(message, new Date(now().getTime() - staleAfterMs));
  if (!job) return "deferred";
  log(`[${job.id}] claimed, attempt ${job.attempt} (delivery ${delivery.receiveCount}/${config.maxAttempts})`);
  const lease: Lease = { ...message, attempt: job.attempt };

  // While rendering, keep the message hidden and the row fresh so that no
  // other worker picks the job up. If this process dies, both lapse.
  let progress = 0;
  // Created before the heartbeat, which stops the attempt as soon as it finds the lease gone.
  const scope = createAttemptScope({ graceMs: (config.abortGraceSeconds ?? DEFAULT_GRACE_MS / 1000) * 1000, log });
  const heartbeat = setInterval(() => {
    delivery.extend(config.visibilitySeconds).catch((error) => log(`[${job.id}] could not extend visibility`, error));
    store.heartbeat(lease, progress).then((held) => {
      if (!held && !scope.signal.aborted) scope.abort(new AttemptStopped(LEASE_LOST, "cancelled"));
    }, (error) => log(`[${job.id}] could not write heartbeat`, error));
  }, config.heartbeatSeconds * 1000);

  // The heartbeat keeps the job this worker's for as long as the process lives, so a render that never
  // settles (a stuck decode, a Chrome that stopped answering) would otherwise never be retried. The
  // deadline and a worker shutdown abort the attempt's scope (ADR 0050); runAttempt settles only after
  // what the render held (Chrome, ffmpeg, temp dirs) is released, so nothing below reports the attempt,
  // or hands the job to another worker, while the old render still runs.
  const timeoutMs = (config.jobTimeoutSeconds ?? 45 * 60) * 1000;
  const cancelDeadline = abortAfter(scope, timeoutMs, () => new AttemptStopped(`Render attempt exceeded ${timeoutMs < 60_000 ? `${timeoutMs / 1000} seconds` : `${Math.round(timeoutMs / 60_000)} minutes`}`, "deadline"));
  const unlinkShutdown = linkAbort(deps.shutdown, scope, () => new AttemptStopped("The worker stopped during the render", "shutdown"), (config.shutdownDrainSeconds ?? 0) * 1000);
  try {
    const output = await runAttempt(scope, () => deps.render(job, (percent) => {
      if (percent >= progress + 5 || percent === 100) {
        progress = percent;
        store.heartbeat(lease, progress).catch((error) => log(`[${job.id}] could not write progress`, error));
      }
    }, scope)).finally(() => clearInterval(heartbeat)); // a tick after this could re-hide a message just handed on
    if (!(await store.succeed(lease, output))) {
      // Another worker took the job over while this one rendered (it was declared stale, or the job was
      // re-queued). Its output stays unpublished and the message is theirs now.
      log(`[${job.id}] rendered, but the job is no longer this worker's; output ${output.objectKey} not published`);
      return "discarded";
    }
    await delivery.delete();
    log(`[${job.id}] succeeded`);
    return "succeeded";
  } catch (error) {
    if (error instanceof AttemptStopped && error.message === LEASE_LOST) {
      // The job's current run is someone else's (the fallback moved it to the cloud, or another worker took
      // it over): nothing of this run was published, and this message is stale.
      log(`[${job.id}] attempt ${job.attempt} stopped: the job was moved to another worker`);
      await delivery.delete().catch((deleteError) => log(`[${job.id}] could not delete the stale message`, deleteError));
      return "discarded";
    }
    const interruptions = job.interruptions ?? 0;
    const interruptible = interruptions < (config.maxInterruptions ?? Infinity);
    if (error instanceof AttemptStopped && error.why === "shutdown" && !interruptible) {
      log(`[${job.id}] interrupted ${interruptions + 1} times; counting this one as a failed attempt`);
    }
    if (error instanceof AttemptStopped && error.why === "shutdown" && interruptible) {
      // Not the job's fault: hand it straight back for another worker, without a backoff and without
      // spending one of its deliveries (a fresh message), so rolling deploys cannot dead-letter it.
      log(`[${job.id}] attempt ${job.attempt} interrupted by shutdown, handing it back`);
      await store.interrupt(lease, errorMessage(error));
      if (!delivery.handBack) {
        await delivery.extend(0);
        return "interrupted";
      }
      try {
        await delivery.handBack();
      } catch (handBackError) {
        log(`[${job.id}] could not hand the message back; making it visible again instead`, handBackError);
        await delivery.extend(0);
      }
      return "interrupted";
    }
    const failure = decideFailure({
      attempt: delivery.receiveCount,
      maxAttempts: config.maxAttempts,
      backoffBaseSeconds: config.retryBackoffSeconds,
    });
    if (failure.status === "QUEUED") {
      log(`[${job.id}] attempt ${job.attempt} failed, retrying in ${failure.retryDelaySeconds}s`, error);
      await store.requeue(lease, errorMessage(error));
      await delivery.extend(failure.retryDelaySeconds);
      return "retrying";
    }
    log(`[${job.id}] failed after ${delivery.receiveCount} attempts`, error);
    await store.fail(lease, errorMessage(error));
    // Not deleted: the next receive exceeds maxReceiveCount and SQS moves it to the DLQ.
    await delivery.extend(0);
    return "failed";
  } finally {
    clearInterval(heartbeat);
    cancelDeadline();
    unlinkShutdown();
  }
}

/**
 * Processes one message from the dead-letter queue. Normally the job is
 * already FAILED. If every attempt killed its worker (out of memory, node
 * loss), nothing ever wrote FAILED, so it is done here.
 */
export async function handleDeadLetter(
  deps: Pick<HandlerDeps, "store" | "log" | "now" | "aiSteps"> & { config: Pick<HandlerDeps["config"], "staleSeconds"> },
  delivery: Pick<Delivery, "body" | "delete">,
): Promise<"failed" | "ignored" | "poison"> {
  if (deps.aiSteps && isAiStepMessage(delivery.body)) return handleAiStepDeadLetter({ ...deps.aiSteps, config: deps.config }, delivery);
  const log = deps.log ?? ((message, error) => (error ? console.error(message, error) : console.log(message)));
  const now = deps.now ?? (() => new Date());

  let message: RenderJobMessage;
  try {
    message = parseRenderJobMessage(delivery.body);
  } catch (error) {
    log(`Dropping unparseable dead letter: ${delivery.body.slice(0, 200)}`, error);
    await delivery.delete();
    return "poison";
  }

  const shouldFail = shouldFailFromDeadLetter({
    job: await deps.store.snapshot(message.jobId),
    message,
    now: now(),
    staleAfterMs: deps.config.staleSeconds * 1000,
  });
  if (shouldFail) {
    log(`[${message.jobId}] dead-lettered while still active, marking failed`);
    await deps.store.failAbandoned(message, "Render attempts were exhausted (the worker stopped before reporting an error).");
  } else {
    log(`[${message.jobId}] dead letter received, job already settled`);
  }
  await delivery.delete();
  return shouldFail ? "failed" : "ignored";
}
