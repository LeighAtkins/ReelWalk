/**
 * The take queue (ADR 0069). Generations used to be refused past two in
 * flight and past ten rows created in an hour, whatever became of them: two
 * takes composing at once failed at compose, and those refunded failures
 * counted toward the hour, so one reel lost forty minutes. Now a workspace's
 * takes wait in a FIFO: compose runs one at a time per workspace, a failure
 * before Veo never counts, and the hour counts only Veo submissions (rows
 * with `submitStartedAt`). Pure: the database layer and the API both read it.
 */
/** Owner-approved increase, 2026-10-30: keep funded test batches moving without removing the cap. */
export const AI_HOURLY_SUBMISSIONS = 20;
/** Takes a workspace may have waiting or generating at once; the credits are reserved the whole time. */
export const AI_QUEUE_LIMIT = 12;
const HOUR_MS = 3_600_000;

export type QueueRow = {
  id: string; status: string; createdAt: Date;
  /** Set under the fence just before the paid Veo call (ADR 0056). */
  submitStartedAt: Date | null;
  leaseUntil: Date | null;
};

export const IN_FLIGHT_STATUSES = ["QUEUED", "SUBMITTING", "RUNNING"] as const;

/** A row a worker holds while it composes and checks the stills (before the fence). */
export const isComposing = (row: QueueRow, now: Date) =>
  row.status === "SUBMITTING" && !row.submitStartedAt && row.leaseUntil !== null && row.leaseUntil > now;

/** Veo submissions in the last hour. */
export const hourlySubmissions = (rows: QueueRow[], now: Date) =>
  rows.filter(row => row.submitStartedAt && row.submitStartedAt.getTime() > now.getTime() - HOUR_MS).length;

/** When the next submission fits the hour, if the hour is full now. */
export function nextSubmissionSlot(rows: QueueRow[], now: Date): Date | null {
  const inWindow = rows.map(row => row.submitStartedAt).filter((at): at is Date => Boolean(at && at.getTime() > now.getTime() - HOUR_MS))
    .sort((a, b) => a.getTime() - b.getTime());
  if (inWindow.length < AI_HOURLY_SUBMISSIONS) return null;
  return new Date(inWindow[inWindow.length - AI_HOURLY_SUBMISSIONS].getTime() + HOUR_MS);
}

export const queued = (rows: QueueRow[]) => rows.filter(row => row.status === "QUEUED").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
export const inFlight = (rows: QueueRow[]) => rows.filter(row => (IN_FLIGHT_STATUSES as readonly string[]).includes(row.status)).length;

export type QueueDecision = { nextId: string | null; blockedBy: "compose" | "hour" | null; slotAt: Date | null };

/** Which queued take a worker may start now for this workspace, or why none. */
export function queueDecision(rows: QueueRow[], now: Date): QueueDecision {
  const waiting = queued(rows);
  if (!waiting.length) return { nextId: null, blockedBy: null, slotAt: null };
  if (rows.some(row => isComposing(row, now))) return { nextId: null, blockedBy: "compose", slotAt: null };
  const slotAt = nextSubmissionSlot(rows, now);
  if (slotAt) return { nextId: null, blockedBy: "hour", slotAt };
  return { nextId: waiting[0].id, blockedBy: null, slotAt: null };
}

export type QueuePosition = {
  /** 1 for the next take to start. */
  position: number;
  /** Why it is not composing yet: a take ahead of it, one being composed now, or the hour. */
  waitingFor: "turn" | "compose" | "hour" | null;
  /** When the hour opens again, if that is what it waits for. */
  slotAt: string | null;
};

/** Where a queued take stands, for the UI and the API. Null for a row that is not queued. */
export function queuePosition(rows: QueueRow[], id: string, now: Date): QueuePosition | null {
  const waiting = queued(rows);
  const index = waiting.findIndex(row => row.id === id);
  if (index < 0) return null;
  const decision = queueDecision(rows, now);
  const waitingFor = index > 0 ? "turn" : decision.blockedBy;
  return { position: index + 1, waitingFor, slotAt: decision.blockedBy === "hour" && decision.slotAt ? decision.slotAt.toISOString() : null };
}

/** The sentence the panel shows for a queued take. */
export function queueLabel(status: QueuePosition | null, timeFormat: (at: Date) => string = at => at.toISOString().slice(11, 16)): string {
  if (!status) return "Waiting to start…";
  const ahead = status.position - 1;
  if (status.waitingFor === "hour" && status.slotAt) return `Waiting for the hourly limit · opens about ${timeFormat(new Date(status.slotAt))}`;
  if (status.waitingFor === "compose") return "Next up · another take is being composed";
  if (ahead > 0) return `Queued · ${ahead} ahead`;
  return "Next up";
}
