import {
  decideDelivery,
  decideFailure,
  parseRenderJobMessage,
  shouldFailFromDeadLetter,
  type JobSnapshot,
  type RenderJobMessage,
} from "@reelwalk/core";
import { abortAfter, AttemptStopped, createAttemptScope, DEFAULT_GRACE_MS, linkAbort, runAttempt, type AttemptScope } from "./lifecycle";

export type ClaimedJob = {
  id: string;
  generation: number;
  /** The attempt this claim wrote (SQS receive count), part of the lease and of the output's key. */
  attempt: number;
  kind: "TEMPLATE" | "EDITOR" | "REEL" | "PREVIEW";
  caption: string | null;
  payload: unknown;
  inputKey: string | null;
  brand: string | null;
  /** For PREVIEW jobs: the upload being transcoded and where its rendition goes. */
  mediaAssetId?: string | null;
  previewKey?: string | null;
};

export type RenderResult = { objectKey: string; contentType: string; sizeBytes: number };

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
  /** QUEUED (or stale RUNNING) -> RUNNING. Returns null if another worker got there first. */
  claim(message: RenderJobMessage, attempt: number, staleBefore: Date): Promise<ClaimedJob | null>;
  heartbeat(lease: Lease, progress?: number): Promise<void>;
  /** Publishes the output and marks the job done; false when the lease was lost, in which case nothing was written. */
  succeed(lease: Lease, output: RenderResult): Promise<boolean>;
  requeue(lease: Lease, error: string): Promise<void>;
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
    /** How long a stopped attempt may take to release what it holds before it is killed. */
    abortGraceSeconds?: number;
  };
  /** Aborted when the worker is stopping (SIGTERM): the attempt is stopped and the job handed back. */
  shutdown?: AbortSignal;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
};

export type Outcome = "succeeded" | "retrying" | "interrupted" | "failed" | "discarded" | "deferred" | "poison";

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

  const job = await store.claim(message, delivery.receiveCount, new Date(now().getTime() - staleAfterMs));
  if (!job) return "deferred";
  log(`[${job.id}] claimed, attempt ${delivery.receiveCount}/${config.maxAttempts}`);
  const lease: Lease = { ...message, attempt: delivery.receiveCount };

  // While rendering, keep the message hidden and the row fresh so that no
  // other worker picks the job up. If this process dies, both lapse.
  let progress = 0;
  const heartbeat = setInterval(() => {
    delivery.extend(config.visibilitySeconds).catch((error) => log(`[${job.id}] could not extend visibility`, error));
    store.heartbeat(lease, progress).catch((error) => log(`[${job.id}] could not write heartbeat`, error));
  }, config.heartbeatSeconds * 1000);

  // The heartbeat keeps the job this worker's for as long as the process lives, so a render that never
  // settles (a stuck decode, a Chrome that stopped answering) would otherwise never be retried. The
  // deadline and a worker shutdown abort the attempt's scope (ADR 0050); runAttempt settles only after
  // what the render held (Chrome, ffmpeg, temp dirs) is released, so nothing below reports the attempt,
  // or hands the job to another worker, while the old render still runs.
  const scope = createAttemptScope({ graceMs: (config.abortGraceSeconds ?? DEFAULT_GRACE_MS / 1000) * 1000, log });
  const timeoutMs = (config.jobTimeoutSeconds ?? 45 * 60) * 1000;
  const cancelDeadline = abortAfter(scope, timeoutMs, () => new AttemptStopped(`Render attempt exceeded ${timeoutMs < 60_000 ? `${timeoutMs / 1000} seconds` : `${Math.round(timeoutMs / 60_000)} minutes`}`, "deadline"));
  const unlinkShutdown = linkAbort(deps.shutdown, scope, () => new AttemptStopped("The worker stopped during the render", "shutdown"));
  try {
    const output = await runAttempt(scope, () => deps.render(job, (percent) => {
      if (percent >= progress + 5 || percent === 100) {
        progress = percent;
        store.heartbeat(lease, progress).catch((error) => log(`[${job.id}] could not write progress`, error));
      }
    }, scope));
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
    if (error instanceof AttemptStopped && error.why === "shutdown") {
      // Not the job's fault: hand it straight back for another worker, without a backoff.
      log(`[${job.id}] attempt ${delivery.receiveCount} interrupted by shutdown, re-queueing`);
      await store.requeue(lease, errorMessage(error));
      await delivery.extend(0);
      return "interrupted";
    }
    const failure = decideFailure({
      attempt: delivery.receiveCount,
      maxAttempts: config.maxAttempts,
      backoffBaseSeconds: config.retryBackoffSeconds,
    });
    if (failure.status === "QUEUED") {
      log(`[${job.id}] attempt ${delivery.receiveCount} failed, retrying in ${failure.retryDelaySeconds}s`, error);
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
  deps: Pick<HandlerDeps, "store" | "log" | "now"> & { config: Pick<HandlerDeps["config"], "staleSeconds"> },
  delivery: Pick<Delivery, "body" | "delete">,
): Promise<"failed" | "ignored" | "poison"> {
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
