import {
  decideDelivery,
  decideFailure,
  parseRenderJobMessage,
  shouldFailFromDeadLetter,
  type JobSnapshot,
  type RenderJobMessage,
} from "@reelwalk/core";

export type ClaimedJob = {
  id: string;
  generation: number;
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

/** Database side of a job. Every write is conditional on the job still being this run's. */
export interface JobStore {
  snapshot(jobId: string): Promise<JobSnapshot | null>;
  /** QUEUED (or stale RUNNING) -> RUNNING. Returns null if another worker got there first. */
  claim(message: RenderJobMessage, attempt: number, staleBefore: Date): Promise<ClaimedJob | null>;
  heartbeat(job: RenderJobMessage, progress?: number): Promise<void>;
  succeed(job: RenderJobMessage, output: RenderResult): Promise<void>;
  requeue(job: RenderJobMessage, error: string): Promise<void>;
  fail(job: RenderJobMessage, error: string): Promise<void>;
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
  render: (job: ClaimedJob, onProgress: (percent: number) => void) => Promise<RenderResult>;
  config: {
    maxAttempts: number;
    visibilitySeconds: number;
    heartbeatSeconds: number;
    staleSeconds: number;
    retryBackoffSeconds: number;
  };
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
};

export type Outcome = "succeeded" | "retrying" | "failed" | "discarded" | "deferred" | "poison";

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

  // While rendering, keep the message hidden and the row fresh so that no
  // other worker picks the job up. If this process dies, both lapse.
  let progress = 0;
  const heartbeat = setInterval(() => {
    delivery.extend(config.visibilitySeconds).catch((error) => log(`[${job.id}] could not extend visibility`, error));
    store.heartbeat(message, progress).catch((error) => log(`[${job.id}] could not write heartbeat`, error));
  }, config.heartbeatSeconds * 1000);

  try {
    const output = await deps.render(job, (percent) => {
      if (percent >= progress + 5 || percent === 100) {
        progress = percent;
        store.heartbeat(message, progress).catch((error) => log(`[${job.id}] could not write progress`, error));
      }
    });
    await store.succeed(message, output);
    await delivery.delete();
    log(`[${job.id}] succeeded`);
    return "succeeded";
  } catch (error) {
    const failure = decideFailure({
      attempt: delivery.receiveCount,
      maxAttempts: config.maxAttempts,
      backoffBaseSeconds: config.retryBackoffSeconds,
    });
    if (failure.status === "QUEUED") {
      log(`[${job.id}] attempt ${delivery.receiveCount} failed, retrying in ${failure.retryDelaySeconds}s`, error);
      await store.requeue(message, errorMessage(error));
      await delivery.extend(failure.retryDelaySeconds);
      return "retrying";
    }
    log(`[${job.id}] failed after ${delivery.receiveCount} attempts`, error);
    await store.fail(message, errorMessage(error));
    // Not deleted: the next receive exceeds maxReceiveCount and SQS moves it to the DLQ.
    await delivery.extend(0);
    return "failed";
  } finally {
    clearInterval(heartbeat);
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
    await deps.store.fail(message, "Render attempts were exhausted (the worker stopped before reporting an error).");
  } else {
    log(`[${message.jobId}] dead letter received, job already settled`);
  }
  await delivery.delete();
  return shouldFail ? "failed" : "ignored";
}
