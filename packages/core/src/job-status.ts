export const RENDER_JOB_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export type RenderJobStatus = (typeof RENDER_JOB_STATUSES)[number];

/**
 * Every legal status change for a render job. Anything not listed here is a
 * bug, and the worker / server actions refuse to write it.
 *
 * QUEUED  -> RUNNING    a worker claimed the job
 * QUEUED  -> FAILED     the message was dead-lettered before any claim
 * RUNNING -> SUCCEEDED  output uploaded
 * RUNNING -> QUEUED     attempt failed, automatic retry scheduled
 * RUNNING -> FAILED     attempts exhausted
 * FAILED  -> QUEUED     manual retry from the UI
 */
const TRANSITIONS: Record<RenderJobStatus, readonly RenderJobStatus[]> = {
  QUEUED: ["RUNNING", "FAILED"],
  RUNNING: ["SUCCEEDED", "QUEUED", "FAILED"],
  SUCCEEDED: [],
  FAILED: ["QUEUED"],
};

export function canTransition(from: RenderJobStatus, to: RenderJobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RenderJobStatus, to: RenderJobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal render job transition ${from} -> ${to}`);
  }
}

/** Statuses a job may be in for `to` to be a legal next status. */
export function sourcesFor(to: RenderJobStatus): RenderJobStatus[] {
  return RENDER_JOB_STATUSES.filter((from) => canTransition(from, to));
}

export function isTerminal(status: RenderJobStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED";
}

export function isActive(status: RenderJobStatus): boolean {
  return !isTerminal(status);
}
