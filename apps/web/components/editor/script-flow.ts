/**
 * Script mode's client side (ADR 0060), framework-free so it is tested: what
 * the script's takes are doing, when to ask the server to start the next one,
 * how to read its answer, and which finished takes to place. The approved
 * script (with its id) is kept in localStorage per reel *before* it is sent,
 * so a lost response or a reload carries on with the same id and the server's
 * request ids never charge a take twice.
 */
import { lineSeconds, type PresenterTakeInsert, type ScriptRequest } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

/** A take's generation as `GET /api/reels/:id/script?scriptId=` returns it. */
export type ScriptJob = { index: number; id: string; status: string; error: string | null; failureCode?: string | null; asset: LibraryAsset | null };
/**
 * `credit` says what happened to a take's credit when it did not come out:
 * returned (failed and refunded), held (could not be confirmed, ADR 0056), spent
 * (made but not in the library), none (never started).
 */
export type TakeState = {
  index: number; line: string; state: "waiting" | "making" | "ready" | "failed";
  jobId?: string; asset?: LibraryAsset; error?: string | null; credit?: "returned" | "held" | "spent" | "none";
};
/** A script the studio approved: its lines, the quote they saw, when, and why it stopped early if it did. */
export type ApprovedScript = { script: ScriptRequest; quotedCredits: number; approvedAt: number; stopped?: { reason: string } };

/** After this long a waiting take is not started on the old approval: the studio is asked again first. */
export const APPROVAL_TTL_MS = 60 * 60_000;
/** Takes a workspace may have generating at once (the server's reservation enforces it). */
export const SCRIPT_IN_FLIGHT_LIMIT = 2;
const IN_FLIGHT = new Set(["QUEUED", "SUBMITTING", "RUNNING"]);

/** Every take of the script, with what its generation is doing (or `waiting` before it is started). */
export function scriptProgress(approved: Pick<ApprovedScript, "script" | "stopped">, jobs: ScriptJob[]): TakeState[] {
  return approved.script.takes.map((take, index) => {
    const base = { index, line: take.line };
    const job = jobs.find((item) => item.index === index);
    if (!job) return approved.stopped ? { ...base, state: "failed", credit: "none", error: approved.stopped.reason } : { ...base, state: "waiting" };
    const made = { ...base, jobId: job.id };
    if (IN_FLIGHT.has(job.status)) return { ...made, state: "making" };
    if (job.status === "SUCCEEDED") return job.asset
      ? { ...made, state: "ready", asset: job.asset }
      : { ...made, state: "failed", credit: "spent", error: "It was made but is no longer in your library." };
    if (job.status === "UNRESOLVED") return { ...made, state: "failed", credit: "held", error: job.error };
    return { ...made, state: "failed", credit: "returned", error: job.error };
  });
}

/** Nothing left to wait for: every take is ready or did not come out. */
export const scriptSettled = (progress: TakeState[]) => progress.length > 0 && progress.every((take) => take.state === "ready" || take.state === "failed");

/** Ask the server to start more: a take is waiting and the workspace has room for another generation. */
export function shouldStartMore(progress: TakeState[], inFlight: number): boolean {
  return progress.some((take) => take.state === "waiting") && inFlight < SCRIPT_IN_FLIGHT_LIMIT;
}

/** The approval is too old to start another take on without asking again. */
export const approvalExpired = (approved: Pick<ApprovedScript, "approvedAt">, now = Date.now()) => now - approved.approvedAt > APPROVAL_TTL_MS;

/**
 * How to take the server's answer to sending the approval: `ok`; `transient`
 * (no answer, signed out, rate-limited, a server error) means keep the script
 * and try again; `permanent` (a refused quote, the balance spent elsewhere, a
 * kit or plate gone) means the takes not started yet will not be.
 */
export function classifyAnswer(status: number | null): "ok" | "transient" | "permanent" {
  if (status !== null && status >= 200 && status < 300) return "ok";
  if (status === null || status === 401 || status === 408 || status === 429 || status >= 500) return "transient";
  return "permanent";
}

/** What sending an approval needs from the outside world, injected so the order of saving and sending is tested. */
export type ApprovalDeps = {
  /** POST the approval; status null when no answer came back (a dropped connection). */
  post(body: { script: ScriptRequest; quotedCredits: number; approved: true }): Promise<{ status: number | null; data: { error?: string; paused?: "busy" | "hourly" } }>;
  /** The script's generations, or null when they could not be read. */
  jobs(scriptId: string): Promise<ScriptJob[] | null>;
  /** Keep (or forget, with null) the approved script. */
  save(approved: ApprovedScript | null): void;
};
export type ApprovalResult = { answer: "ok" | "transient" | "permanent"; approved: ApprovedScript | null; note: string | null };

/**
 * Send an approval (the first time or again). A refusal before anything was
 * made forgets the script (nothing was charged); a refusal after some takes
 * were made stops the rest and keeps what was made; anything else keeps the
 * script exactly as it is, to be sent again with the same id.
 */
export async function sendApproval(current: ApprovedScript, deps: ApprovalDeps): Promise<ApprovalResult> {
  const { status, data } = await deps.post({ script: current.script, quotedCredits: current.quotedCredits, approved: true })
    .catch((): Awaited<ReturnType<ApprovalDeps["post"]>> => ({ status: null, data: {} }));
  const answer = classifyAnswer(status);
  if (answer === "ok") return { answer, approved: current, note: data.paused === "hourly" ? "Paused: the hourly limit for AI takes is reached. The rest start by themselves when it clears." : null };
  if (answer === "transient") return { answer, approved: current, note: "No answer yet. It will try again by itself; nothing is charged twice." };
  const reason = data.error ?? "The rest of the script could not be started.";
  const made = await deps.jobs(current.script.scriptId).catch(() => null);
  // Only a definite "nothing was made" forgets the script; if that cannot be read, keep it and stop the rest.
  const next = made && made.length === 0 ? null : { ...current, stopped: { reason } };
  deps.save(next);
  return { answer, approved: next, note: reason };
}

/** A new approval: kept *before* it is sent, so a lost response carries on with the same script id instead of charging the lines again. */
export async function startScript(script: ScriptRequest, quotedCredits: number, now: number, deps: ApprovalDeps): Promise<ApprovalResult> {
  const approved: ApprovedScript = { script, quotedCredits, approvedAt: now };
  deps.save(approved);
  return sendApproval(approved, deps);
}

/** The ready takes as the `insertPresenterTakes` command places them (all of them once settled, or what is ready on "Stop here"). */
export function takesToPlace(script: ScriptRequest, progress: TakeState[]): PresenterTakeInsert[] {
  return progress.flatMap((take) => take.state === "ready" && take.asset ? [{
    assetId: take.asset.id,
    durationMs: take.asset.durationMs ?? lineSeconds(script.takes[take.index].line) * 1000,
    afterClipId: script.takes[take.index].afterClipId,
    fraction: script.takes[take.index].fraction,
    index: take.index,
  }] : []);
}

/** One line for the sheet: how far the script has got, and what happened to the credit of each take that did not come out. */
export function progressSummary(progress: TakeState[]): string {
  const count = (test: (take: TakeState) => boolean) => progress.filter(test).length;
  const failed = (credit: TakeState["credit"]) => count((take) => take.state === "failed" && take.credit === credit);
  const ready = count((take) => take.state === "ready"), making = count((take) => take.state === "making"), waiting = count((take) => take.state === "waiting");
  const returned = failed("returned"), held = failed("held"), spent = failed("spent"), none = failed("none");
  return [
    ready ? `${ready} ready` : "",
    making ? `${making} being made` : "",
    waiting ? `${waiting} waiting ${waiting === 1 ? "its" : "their"} turn` : "",
    returned ? `${returned} did not come out (credit returned)` : "",
    held ? `${held} could not be confirmed (credit held, never charged twice)` : "",
    spent ? `${spent} made but missing from your library` : "",
    none ? `${none} not started (no credit used)` : "",
  ].filter(Boolean).join(" · ") || "Starting…";
}

const storageKey = (reelId: string) => `reelwalk:script:${reelId}`;
export function loadApproved(reelId: string, storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): ApprovedScript | null {
  try {
    const raw = storage?.getItem(storageKey(reelId));
    const parsed = raw ? JSON.parse(raw) as ApprovedScript : null;
    return parsed && parsed.script && typeof parsed.script.scriptId === "string" && Array.isArray(parsed.script.takes)
      && typeof parsed.quotedCredits === "number" && typeof parsed.approvedAt === "number" ? parsed : null;
  } catch { return null; }
}
export function saveApproved(reelId: string, approved: ApprovedScript | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    if (approved) storage?.setItem(storageKey(reelId), JSON.stringify(approved));
    else storage?.removeItem(storageKey(reelId));
  } catch { /* private mode: the script still runs while the tab is open */ }
}
