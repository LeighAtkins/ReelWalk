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

/**
 * What an export screen says while a render is in flight: the phase, and
 * how long it has taken and probably has left. The estimate assumes the rest
 * goes at the pace so far, so it only appears once there is a pace to go on.
 */
export function exportProgressText(
  job: { status: RenderJobStatus; progress: number; createdAt: Date; startedAt: Date | null },
  now: Date,
): { phase: string; detail: string | null } {
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  if (job.status === "QUEUED") {
    const waited = now.getTime() - job.createdAt.getTime();
    return waited < 120_000
      ? { phase: "Starting a render machine", detail: "Usually under a minute" }
      : { phase: "Waiting for a render slot", detail: `Queued ${minutes(waited)} min ago` };
  }
  if (job.status !== "RUNNING") return { phase: "", detail: null };
  const elapsed = now.getTime() - (job.startedAt ?? job.createdAt).getTime();
  // The worker reports the first fifth while it prepares the clips.
  const phase = job.progress < 20 ? "Preparing your clips" : "Rendering 1080×1920";
  if (job.progress < 25 || elapsed < 30_000) return { phase, detail: elapsed >= 60_000 ? `${minutes(elapsed)} min so far` : null };
  const left = (elapsed * (100 - job.progress)) / job.progress;
  return { phase, detail: left < 60_000 ? "Under a minute left" : `About ${minutes(left)} min left` };
}
