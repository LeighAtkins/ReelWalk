import { z } from "zod";
import type { RenderJobStatus } from "./job-status";

/**
 * The queue message only points at the job row. Everything else lives in
 * Postgres, so a message stays tiny and can never disagree with the database.
 * It is written to the outbox table together with the job row, then sent.
 * `generation` is bumped on every manual retry so that messages left over
 * from an earlier run of the same job can be recognised and thrown away.
 */
export const renderJobMessageSchema = z.object({
  jobId: z.string().min(1),
  generation: z.number().int().min(1),
});
export type RenderJobMessage = z.infer<typeof renderJobMessageSchema>;

export function serializeRenderJobMessage(message: RenderJobMessage): string {
  return JSON.stringify(renderJobMessageSchema.parse(message));
}

export function parseRenderJobMessage(raw: string): RenderJobMessage {
  return renderJobMessageSchema.parse(JSON.parse(raw));
}

export type JobSnapshot = {
  status: RenderJobStatus;
  generation: number;
  heartbeatAt: Date | null;
};

/**
 * claim   - this worker should take the job
 * discard - the message is a duplicate or stale; delete it
 * defer   - another worker is still rendering; leave the message for later
 */
export type DeliveryDecision = "claim" | "discard" | "defer";

/**
 * SQS delivers at least once, so the same message can arrive twice, or arrive
 * again after a worker crashed mid-render. This decides what a worker does
 * with a delivery so that retries never produce a second output.
 */
export function decideDelivery(input: {
  job: JobSnapshot | null;
  message: RenderJobMessage;
  now: Date;
  staleAfterMs: number;
}): DeliveryDecision {
  const { job, message, now, staleAfterMs } = input;
  if (!job) return "discard";
  if (job.generation !== message.generation) return "discard";
  if (job.status === "QUEUED") return "claim";
  if (job.status === "RUNNING") {
    const heartbeatAge = job.heartbeatAt ? now.getTime() - job.heartbeatAt.getTime() : Infinity;
    return heartbeatAge > staleAfterMs ? "claim" : "defer";
  }
  return "discard";
}

export type FailureDecision = { status: "QUEUED"; retryDelaySeconds: number } | { status: "FAILED" };

/** Exponential backoff: base, 2x base, 4x base ... capped. `attempt` starts at 1. */
export function retryDelaySeconds(attempt: number, baseSeconds: number, capSeconds = 900): number {
  return Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
}

/**
 * What to do after an attempt threw. `maxAttempts` must match the queue's
 * redrive `maxReceiveCount`, so the last failed attempt is also the one after
 * which SQS moves the message to the dead-letter queue.
 */
export function decideFailure(input: {
  attempt: number;
  maxAttempts: number;
  backoffBaseSeconds: number;
}): FailureDecision {
  if (input.attempt >= input.maxAttempts) return { status: "FAILED" };
  return { status: "QUEUED", retryDelaySeconds: retryDelaySeconds(input.attempt, input.backoffBaseSeconds) };
}

/**
 * A message in the dead-letter queue means no worker finished it. If the job
 * row still looks alive (a worker crashed on every attempt and never wrote
 * FAILED), the row has to be failed here or it would stay RUNNING forever.
 *
 * A RUNNING job with a fresh heartbeat is the exception: a worker still has
 * it, and the dead letter is a duplicate message that used up its receives
 * being deferred while the render ran. Failing the job then would cut off a
 * render that is about to succeed.
 */
export function shouldFailFromDeadLetter(input: {
  job: JobSnapshot | null;
  message: RenderJobMessage;
  now: Date;
  staleAfterMs: number;
}): boolean {
  const { job, message, now, staleAfterMs } = input;
  if (!job) return false;
  if (job.generation !== message.generation) return false;
  if (job.status === "QUEUED") return true;
  if (job.status === "RUNNING") {
    const heartbeatAge = job.heartbeatAt ? now.getTime() - job.heartbeatAt.getTime() : Infinity;
    return heartbeatAge > staleAfterMs;
  }
  return false;
}
