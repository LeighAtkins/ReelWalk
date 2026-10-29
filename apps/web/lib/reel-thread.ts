import { timelineDurationMs, timelineGeneration } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { aiAvailabilityReason, reserveAiEdit } from "./ai-edit";
import { runAiJobInBackground } from "./ai-jobs";
import type { ExportFence, ExportResult } from "./export-reel";
import type { ActingUser } from "./mcp/acting-user";
import { allow } from "./mcp/http";
import { aiProvider, claudeToolTurn, isAiConfigured, isFakeAi } from "./openai";
import { NoteRunError, fakeNoteTurn, noteBrief, noteToolSpecs, reelVersions, runNote, type NoteCall, type NoteDeps, type NoteOutcome } from "./reel-notes";
import { ensureChecks, exportTimeline, type ChecksResult } from "./render-verify";
import { readTimeline } from "./reels";
import { withSaveFence, type SaveFence, type Tx } from "./save-fence";
import { saveReelFor } from "./save-reel";

/**
 * A reel's thread (ADR 0095): its versions (the REEL exports, v1 first) and
 * the notes that made them. Notes are AiEdit rows with `plan.kind: "note"`,
 * so they count against the month's AI requests like Ask and the director,
 * and need no table of their own.
 *
 * A note's life: reserved (with every other AI request, reserveAiEdit),
 * working until its times run out, then exported / saved (changed, not
 * exported) / no-change / failed, or expired when its run never finished.
 * Its times are the database's: it may save until `saveBy`, and from
 * `expiresAt` it can be expired. Every save and every export is checked
 * against the note at the write, in the write's own transaction (the note's
 * row is locked there), and records itself in that same transaction; expiry
 * is one conditional UPDATE on the same row. So a write and an expiry are
 * always ordered, nothing lands after expiry, and what landed is never missing
 * from the note.
 */

export type NoteStatus = "working" | "exported" | "saved" | "no-change" | "failed" | "expired";

export type NotePlan = {
  kind: "note";
  requestId: string;
  status: NoteStatus;
  /** No model turn after this (ISO, database time). */
  deadlineAt: string;
  /** No save after this. */
  saveBy: string;
  /** From this the note may be expired; no export after it. */
  expiresAt: string;
  fromExportId: string | null;
  toExportId: string | null;
  revisionBefore: number;
  revisionAfter: number | null;
  calls: NoteCall[];
  costUsd: number;
  error?: string;
};

export type ThreadNote = { id: string; note: string; reply: string; status: NoteStatus; fromExportId: string | null; toExportId: string | null; applied: string[]; costUsd: number; createdAt: string };

export type ThreadVersion = {
  exportId: string;
  label: string;
  status: string;
  createdAt: string;
  durationMs: number | null;
  /** The reel's saved cut is this version's cut. */
  current: boolean;
  /** The note this version answers, when a note made it. */
  note: ThreadNote | null;
  checks: ChecksResult | null;
};

export type Thread = { versions: ThreadVersion[]; notes: ThreadNote[]; working: ThreadNote | null };

/** How long a note may run, how close to the end it may still save, and how long after the end it is expired. */
export type NoteTiming = { deadlineMs: number; saveGuardMs: number; graceMs: number };
export const NOTE_TIMING: NoteTiming = { deadlineMs: 10 * 60_000, saveGuardMs: 30_000, graceMs: 60_000 };
/** Earlier notes the agent is reminded of. */
const HISTORY = 5;
/** Notes read for the thread, newest first. */
const NOTES_SHOWN = 50;

const asPlan = (value: unknown): NotePlan | null => (value && typeof value === "object" && (value as { kind?: unknown }).kind === "note" ? (value as NotePlan) : null);

/** What an expired note says, from what it is known (now) to have committed. */
export function expiredReply(plan: Pick<NotePlan, "toExportId" | "revisionAfter" | "revisionBefore">): string {
  if (plan.toExportId) return "This note stopped after its version was queued; the version is below.";
  if (plan.revisionAfter !== null && plan.revisionAfter !== undefined && plan.revisionAfter !== plan.revisionBefore) {
    return `This note stopped after saving its change (revision ${plan.revisionAfter}) but before exporting it. The change is in the editor: export it from there, or go back to a version.`;
  }
  return "This note stopped before it changed anything (the server restarted or it ran out of time). Send it again.";
}

type Db = Pick<typeof prisma, "$executeRaw">;

/**
 * Expires the reel's working notes whose time is up, by the database's clock,
 * in one statement: eligibility is decided at the update, under the row's
 * lock, so a save or export holding the row is waited for, never overtaken.
 */
function expireOverdue(db: Db, workspaceId: string, reelId: string) {
  return db.$executeRaw`UPDATE "AiEdit" SET plan = jsonb_set(plan, '{status}', '"expired"')
    WHERE "workspaceId" = ${workspaceId} AND "reelId" = ${reelId} AND plan->>'kind' = 'note' AND plan->>'status' = 'working'
      AND now() >= COALESCE((plan->>'expiresAt')::timestamptz, "createdAt" + interval '11 minutes')`;
}

/** Locks a note's row and answers whether it is still working and inside `field` (database time; at the instant itself it is closed). */
async function lockOpen(tx: Tx, noteId: string, field: "saveBy" | "expiresAt"): Promise<"open" | "stopped" | "late"> {
  const rows = await tx.$queryRaw<{ status: string | null; open: boolean }[]>`SELECT plan->>'status' AS status, now() < (plan->>${field})::timestamptz AS open FROM "AiEdit" WHERE id = ${noteId} FOR UPDATE`;
  const row = rows[0];
  if (!row || row.status !== "working") return "stopped";
  return row.open ? "open" : "late";
}

/** Merges facts into a note's plan atomically, whatever its status. */
function recordFacts(db: Db, id: string, facts: Partial<NotePlan>) {
  return db.$executeRaw`UPDATE "AiEdit" SET plan = plan || ${JSON.stringify(facts)}::jsonb WHERE id = ${id}`;
}

/** Moves a note from working to `status`; answers false when it was no longer working (expired meanwhile). */
async function settle(id: string, status: NoteStatus, reply: string): Promise<boolean> {
  const count = await prisma.$executeRaw`UPDATE "AiEdit" SET plan = jsonb_set(plan, '{status}', to_jsonb(${status}::text)), note = ${reply} WHERE id = ${id} AND plan->>'status' = 'working'`;
  return count > 0;
}

function toNote(row: { id: string; request: string; note: string; plan: unknown; applied: unknown; createdAt: Date }): ThreadNote | null {
  const plan = asPlan(row.plan);
  if (!plan) return null;
  return {
    id: row.id,
    note: row.request,
    // An expired note's words come from its facts as they are now, never from the moment it expired.
    reply: plan.status === "expired" ? expiredReply(plan) : row.note,
    status: plan.status,
    fromExportId: plan.fromExportId,
    toExportId: plan.toExportId,
    applied: Array.isArray(row.applied) ? row.applied.map(String) : [],
    costUsd: plan.costUsd ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The reel's newest notes (oldest first in the answer), with any whose time is up expired first. */
export async function reelNotes(workspaceId: string, reelId: string, options: { limit?: number } = {}): Promise<ThreadNote[]> {
  await expireOverdue(prisma, workspaceId, reelId);
  const rows = await prisma.aiEdit.findMany({
    where: { workspaceId, reelId, plan: { path: ["kind"], equals: "note" } },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? NOTES_SHOWN,
    select: { id: true, request: true, note: true, plan: true, applied: true, createdAt: true },
  });
  return rows.reverse().map(toNote).filter((note): note is ThreadNote => note !== null);
}

/** The thread for the export screen: up to `limit` newest versions with their checks, and the recent notes. */
export async function reelThread(workspaceId: string, reelId: string, options: { limit?: number } = {}): Promise<Thread> {
  const [reel, shown, notes] = await Promise.all([
    prisma.reel.findFirst({ where: { id: reelId, workspaceId }, select: { timeline: true } }),
    reelVersions(workspaceId, reelId, { last: options.limit ?? 6 }),
    reelNotes(workspaceId, reelId),
  ]);
  const jobs = await prisma.renderJob.findMany({ where: { id: { in: shown.map((version) => version.id) } }, select: { id: true, payload: true, output: { select: { objectKey: true } } } });
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const current = reel ? timelineGeneration(readTimeline(reel.timeline)) : null;
  const out: ThreadVersion[] = [];
  for (const version of shown) {
    const job = byId.get(version.id);
    const timeline = job ? exportTimeline(job.payload) : null;
    const checks = job?.output && version.status === "SUCCEEDED"
      ? await ensureChecks(job, { compute: false }).catch((): ChecksResult => ({ checks: null, source: "none", reason: "The checks could not be read." }))
      : null;
    out.push({
      exportId: version.id,
      label: version.label,
      status: version.status,
      createdAt: version.createdAt.toISOString(),
      durationMs: timeline ? timelineDurationMs(timeline) : null,
      current: Boolean(timeline && current && timelineGeneration(timeline) === current),
      note: notes.find((note) => note.toExportId === version.id) ?? null,
      checks,
    });
  }
  return { versions: out.reverse(), notes, working: notes.find((note) => note.status === "working") ?? null };
}

/** Notes are offered when Claude (or the stand-in) is there. */
export function notesAvailable(): boolean {
  if (isFakeAi()) return true;
  try {
    return isAiConfigured() && aiProvider() !== "openai";
  } catch {
    return false;
  }
}

export type StartNote =
  | { ok: true; noteId: string; jobId: string; /** Settles when the note's run is over (tests; routes ignore it). */ settled: Promise<void> }
  | { ok: false; status: number; message: string; upgrade?: boolean };

/** What a note runs with; tests replace these. */
export type NoteRunDeps = {
  run: typeof runNote;
  tools: NoteDeps;
  queueExport: (user: { id: string; workspaceId: string }, reelId: string, options: { revision: number; fence: ExportFence }) => Promise<{ ok: true; jobId: string } | ExportResult>;
  timing: NoteTiming;
};

const defaultDeps = (): NoteRunDeps => ({
  run: runNote,
  tools: { turn: isFakeAi() ? fakeNoteTurn : claudeToolTurn, gate: allow, tools: noteToolSpecs() },
  queueExport: async (user, reelId, options) => (await import("./export-reel")).queueReelExport(user, reelId, options),
  timing: NOTE_TIMING,
});

type Early = { kind: "existing"; noteId: string } | { kind: "conflict" } | { kind: "busy" } | { kind: "missing" };

/**
 * Starts a note in the background (ADR 0021's AiJob) and answers at once: a
 * phone that sleeps does not stop it. The reservation is the one every AI
 * request goes through (reserveAiEdit). Under its lock, before the allowance
 * is counted: a retry of the same request id gets the same note (only for the
 * same reel and words), so the last allowed note can be retried; the reel's
 * overdue notes are expired and a live one refuses. Then the note and its job
 * are created together, with its times from the database's clock.
 */
export async function startNote(input: { user: ActingUser; reelId: string; note: string; origin: string; requestId: string }, deps: NoteRunDeps = defaultDeps()): Promise<StartNote> {
  const { user, reelId, requestId } = input;
  const workspaceId = user.workspaceId;
  const note = input.note.trim();
  if (note.length < 3 || note.length > 600) return { ok: false, status: 400, message: "Write the note in a few words (up to 600 characters)." };
  if (!notesAvailable()) return { ok: false, status: 503, message: "Notes need Claude, which is not set up on this deployment." };
  // Whether AI is on at all; the allowance is the reservation's to decide, after a retry is recognised.
  const unavailable = await aiAvailabilityReason(workspaceId);
  if (unavailable) return { ok: false, status: 403, message: unavailable.message };
  const latest = (await reelVersions(workspaceId, reelId, { last: 1 }))[0] ?? null;
  const jobId = `note-${requestId}`;
  const { deadlineMs, saveGuardMs, graceMs } = deps.timing;
  // Read under the reservation's lock (in `before`) and used to create the note.
  const found: { reel?: { title: string; revision: number } } = {};

  const reserved = await reserveAiEdit<{ noteId: string; plan: NotePlan }, Early>(
    workspaceId,
    async (tx) => {
      const draft = {
        kind: "note", requestId, status: "working", fromExportId: latest?.id ?? null, toExportId: null,
        revisionBefore: found.reel!.revision, revisionAfter: null, calls: [], costUsd: 0,
      };
      const row = await tx.aiEdit.create({ data: { workspaceId, userId: user.id, reelId, request: note, note: "Working on it", model: "pending", plan: draft, applied: [], skipped: [] }, select: { id: true } });
      // The note's times, from the database's clock: the same clock every write and expiry is checked against.
      const [times] = await tx.$queryRaw<{ plan: NotePlan }[]>`UPDATE "AiEdit" SET plan = plan || jsonb_build_object(
          'deadlineAt', to_char((now() + ${deadlineMs}::int * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'saveBy', to_char((now() + ${deadlineMs - saveGuardMs}::int * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'expiresAt', to_char((now() + ${deadlineMs + graceMs}::int * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        WHERE id = ${row.id} RETURNING plan`;
      await tx.aiJob.create({ data: { id: jobId, workspaceId, reelId, kind: "note" } });
      return { noteId: row.id, plan: times.plan };
    },
    {
      before: async (tx) => {
        const same = await tx.aiEdit.findFirst({ where: { workspaceId, plan: { path: ["requestId"], equals: requestId } }, select: { id: true, reelId: true, request: true } });
        if (same) return same.reelId === reelId && same.request === note ? { kind: "existing", noteId: same.id } : { kind: "conflict" };
        const reel = await tx.reel.findFirst({ where: { id: reelId, workspaceId }, select: { title: true, revision: true } });
        if (!reel) return { kind: "missing" };
        found.reel = reel;
        await expireOverdue(tx, workspaceId, reelId);
        const live = await tx.aiEdit.count({ where: { workspaceId, reelId, plan: { path: ["status"], equals: "working" } } });
        return live > 0 ? { kind: "busy" } : null;
      },
    },
  );

  if (!reserved.ok) {
    if ("blocked" in reserved) return { ok: false, status: 403, message: reserved.blocked.message, upgrade: reserved.blocked.upgrade };
    const early = reserved.early;
    if (early.kind === "existing") return { ok: true, noteId: early.noteId, jobId, settled: Promise.resolve() };
    if (early.kind === "conflict") return { ok: false, status: 409, message: "That request was already used for a different note. Send the note again." };
    if (early.kind === "missing") return { ok: false, status: 404, message: "This reel was deleted." };
    return { ok: false, status: 409, message: "A note on this reel is still being worked on. Wait for its version." };
  }

  const { noteId, plan } = reserved.value;
  const [versions, history] = await Promise.all([reelVersions(workspaceId, reelId, { last: 20 }), reelNotes(workspaceId, reelId, { limit: HISTORY + 1 })]);
  const brief = noteBrief({
    title: found.reel!.title,
    reelId,
    revision: plan.revisionBefore,
    versions: versions.map((version) => ({ label: version.label, exportId: version.id, status: version.status })),
    history: history.filter((entry) => entry.id !== noteId && entry.status !== "working").slice(-HISTORY).map((entry) => ({ note: entry.note, reply: entry.reply })),
    note,
  });
  const exportIds = versions.filter((version) => version.status === "SUCCEEDED").map((version) => version.id);
  const settled = runAiJobInBackground(jobId, () => executeNote({ user, reelId, note, origin: input.origin, brief, exportIds, noteId, plan }, deps));
  return { ok: true, noteId, jobId, settled };
}

const emptyOutcome = (revision: number): NoteOutcome => ({ reply: "", changed: false, revisionBefore: revision, revisionAfter: revision, applied: [], calls: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }, model: "", costUsd: 0 });

/** The fences a note's writes go through: each checks the note at the write and records itself in the write's transaction. */
export function noteFences(noteId: string) {
  let pending: string[] = [];
  const save: SaveFence = {
    async check(tx) {
      const state = await lockOpen(tx, noteId, "saveBy");
      if (state === "stopped") return "This note was stopped; nothing more can be saved. Answer the owner now.";
      if (state === "late") return "The note is out of time; nothing more can be saved. Answer the owner now.";
      return null;
    },
    async committed(tx, revision) {
      await tx.$executeRaw`UPDATE "AiEdit" SET plan = plan || jsonb_build_object('revisionAfter', ${revision}::int), applied = applied || ${JSON.stringify(pending)}::jsonb WHERE id = ${noteId}`;
      pending = [];
    },
  };
  const exporting: ExportFence = {
    async check(tx) {
      const state = await lockOpen(tx, noteId, "expiresAt");
      return state === "open" ? null : "The note had been stopped, so the change was not exported; it is in the editor.";
    },
    async committed(tx, jobId) {
      await recordFacts(tx, noteId, { toExportId: jobId });
    },
  };
  return { save, exporting, applying: (lines: string[]) => void (pending = lines) };
}

/** One note's run, after its reservation: the agent, then the export of exactly the revision it saved, then the record. */
async function executeNote(input: { user: ActingUser; reelId: string; note: string; origin: string; brief: string; exportIds: string[]; noteId: string; plan: NotePlan }, deps: NoteRunDeps) {
  const { user, reelId, noteId, plan } = input;
  const fences = noteFences(noteId);
  let outcome: NoteOutcome = emptyOutcome(plan.revisionBefore);
  let failure: string | null = null;
  let status: NoteStatus = "failed";
  let toExportId: string | null = null;
  let settled = false;
  try {
    try {
      outcome = await withSaveFence(fences.save, () =>
        deps.run(
          { user, reelId, note: input.note, origin: input.origin, brief: input.brief, exportIds: input.exportIds, revision: plan.revisionBefore, deadline: Date.parse(plan.deadlineAt), onApplying: fences.applying },
          deps.tools,
        ),
      );
    } catch (error) {
      if (error instanceof NoteRunError) outcome = error.partial;
      failure = error instanceof Error ? error.message : String(error);
    }

    let exportLine = "";
    if (outcome.changed) {
      const queued = await deps
        .queueExport(user, reelId, { revision: outcome.revisionAfter, fence: fences.exporting })
        .catch((error: unknown): ExportResult => ({ ok: false, issues: [], message: error instanceof Error ? error.message : String(error) }));
      if (queued.ok) toExportId = queued.jobId;
      else {
        const why = queued.message ?? queued.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join(" ");
        exportLine = queued.fenced
          ? ` ${why}`
          : queued.conflict
            ? " The reel was edited while the note was being worked on, so this version was not exported on its own; the change is in the editor."
            : ` The new version could not be exported: ${why || "the export was refused"}. The change is in the editor.`;
      }
    }

    status = toExportId ? "exported" : outcome.changed ? "saved" : failure ? "failed" : "no-change";
    const reply = (failure
      ? outcome.changed
        ? `The change was saved${toExportId ? " and the new version exported" : ""}, but Opus stopped before summing it up (${failure}).`
        : `That note did not work: ${failure}`
      : outcome.reply) + exportLine;
    await recordFacts(prisma, noteId, { calls: outcome.calls, costUsd: outcome.costUsd, ...(failure ? { error: failure.slice(0, 500) } : {}) });
    await prisma.aiEdit.update({
      where: { id: noteId },
      data: { model: outcome.model || "none", inputTokens: outcome.usage.inputTokens, cachedTokens: outcome.usage.cachedTokens, outputTokens: outcome.usage.outputTokens },
    });
    settled = await settle(noteId, status, reply.slice(0, 2000));
  } catch (error) {
    failure = `${failure ? `${failure}; ` : ""}recording the note failed: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  } finally {
    // One line per note for the logs and the cost dashboard, on every path, even when recording it failed.
    console.log(JSON.stringify({
      event: "reel-note", noteId, reelId, workspaceId: user.workspaceId, status: settled ? status : `${status} (not recorded as such)`, failure, model: outcome.model, calls: outcome.calls.length,
      refused: outcome.calls.filter((call) => call.refused).length, inputTokens: outcome.usage.inputTokens, cachedTokens: outcome.usage.cachedTokens,
      cacheWriteTokens: outcome.usage.cacheWriteTokens ?? 0, outputTokens: outcome.usage.outputTokens, costUsd: Number(outcome.costUsd.toFixed(4)), toExportId,
    }));
  }
  return { ok: !failure, noteId, status, toExportId };
}

export type Restore = { ok: true; revision: number; exportId: string } | { ok: false; status: number; message: string };

/**
 * "Back to vN": the reel's cut becomes exactly the timeline that version was
 * rendered from, as one new revision (the editor can undo it like any save).
 * Exact: no field of the current cut survives (a plain save keeps text fields
 * the incoming timeline leaves out). Nothing is rendered: vN's export is
 * already there to post.
 */
export async function restoreVersion(user: { workspaceId: string }, reelId: string, exportId: string): Promise<Restore> {
  const [reel, job] = await Promise.all([
    prisma.reel.findFirst({ where: { id: reelId, workspaceId: user.workspaceId }, select: { revision: true } }),
    prisma.renderJob.findFirst({ where: { id: exportId, reelId, workspaceId: user.workspaceId, kind: "REEL", status: "SUCCEEDED" }, select: { payload: true } }),
  ]);
  if (!reel) return { ok: false, status: 404, message: "This reel was deleted." };
  const timeline = job ? exportTimeline(job.payload) : null;
  if (!timeline) return { ok: false, status: 404, message: "That version is not a finished export of this reel." };
  const saved = await saveReelFor(user, { id: reelId, revision: reel.revision, timeline }, { exact: true });
  if (!saved.ok) return { ok: false, status: saved.reason === "conflict" ? 409 : 400, message: saved.message };
  return { ok: true, revision: saved.revision, exportId };
}
