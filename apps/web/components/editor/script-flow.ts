/**
 * Script mode's client side (ADR 0060), framework-free so it is tested: what
 * the script's takes are doing, when to ask the server to start the next one,
 * and which finished takes to place. The approved script is kept in
 * localStorage per reel so a closed sheet or a reload carries on; the takes
 * themselves carry their script on the server (`shot.script`).
 */
import { lineSeconds, type PresenterTakeInsert, type ScriptRequest } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

/** A generation as `/api/ai/generations` lists it. */
export type ScriptJob = { id: string; status: string; error: string | null; shot: unknown; asset: LibraryAsset | null };
export type TakeState = { index: number; line: string; state: "waiting" | "making" | "ready" | "failed"; jobId?: string; asset?: LibraryAsset; error?: string | null };
/** A script the studio approved: its lines and the credit quote they saw. */
export type ApprovedScript = { script: ScriptRequest; quotedCredits: number };

const IN_FLIGHT = new Set(["QUEUED", "SUBMITTING", "RUNNING"]);
const FAILED = new Set(["FAILED", "CANCELLED", "UNRESOLVED"]);
/** Takes a workspace may have generating at once (the server's reservation enforces it). */
export const SCRIPT_IN_FLIGHT_LIMIT = 2;

const scriptOf = (job: ScriptJob): { id?: unknown; index?: unknown } | null => {
  const shot = job.shot as { script?: { id?: unknown; index?: unknown } } | null;
  return shot && typeof shot === "object" && shot.script && typeof shot.script === "object" ? shot.script : null;
};

/** Every take of the script, with what its generation is doing (or `waiting` before it is started). */
export function scriptProgress(script: ScriptRequest, jobs: ScriptJob[]): TakeState[] {
  return script.takes.map((take, index) => {
    const job = jobs.find((item) => { const meta = scriptOf(item); return meta?.id === script.scriptId && meta.index === index; });
    if (!job) return { index, line: take.line, state: "waiting" };
    if (job.status === "SUCCEEDED" && job.asset) return { index, line: take.line, state: "ready", jobId: job.id, asset: job.asset };
    if (FAILED.has(job.status) || job.status === "SUCCEEDED") return { index, line: take.line, state: "failed", jobId: job.id, error: job.error };
    return { index, line: take.line, state: "making", jobId: job.id };
  });
}

/** Nothing left to wait for: every take is ready or failed. */
export const scriptSettled = (progress: TakeState[]) => progress.every((take) => take.state === "ready" || take.state === "failed");

/** Ask the server to start more: a take is waiting and the workspace has room for another generation. */
export function shouldStartMore(progress: TakeState[], jobs: ScriptJob[]): boolean {
  return progress.some((take) => take.state === "waiting") && jobs.filter((job) => IN_FLIGHT.has(job.status)).length < SCRIPT_IN_FLIGHT_LIMIT;
}

/** The finished takes as the `insertPresenterTakes` command places them. */
export function takesToPlace(script: ScriptRequest, progress: TakeState[]): PresenterTakeInsert[] {
  return progress.flatMap((take) => take.state === "ready" && take.asset ? [{
    assetId: take.asset.id,
    durationMs: take.asset.durationMs ?? lineSeconds(script.takes[take.index].line) * 1000,
    afterClipId: script.takes[take.index].afterClipId,
    fraction: script.takes[take.index].fraction,
    index: take.index,
  }] : []);
}

/** One line for the sheet: how far the script has got. */
export function progressSummary(progress: TakeState[]): string {
  const count = (state: TakeState["state"]) => progress.filter((take) => take.state === state).length;
  const ready = count("ready"), failed = count("failed"), making = count("making"), waiting = count("waiting");
  const parts = [ready ? `${ready} ready` : "", making ? `${making} being made` : "", waiting ? `${waiting} waiting ${waiting === 1 ? "its" : "their"} turn` : "", failed ? `${failed} did not come out (credit returned)` : ""];
  return parts.filter(Boolean).join(" · ") || "Nothing yet";
}

const storageKey = (reelId: string) => `reelwalk:script:${reelId}`;
export function loadApproved(reelId: string, storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): ApprovedScript | null {
  try {
    const raw = storage?.getItem(storageKey(reelId));
    const parsed = raw ? JSON.parse(raw) as ApprovedScript : null;
    return parsed && parsed.script && Array.isArray(parsed.script.takes) && typeof parsed.quotedCredits === "number" ? parsed : null;
  } catch { return null; }
}
export function saveApproved(reelId: string, approved: ApprovedScript | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    if (approved) storage?.setItem(storageKey(reelId), JSON.stringify(approved));
    else storage?.removeItem(storageKey(reelId));
  } catch { /* private mode: the script still runs while the tab is open */ }
}
