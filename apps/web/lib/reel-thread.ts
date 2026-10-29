import { timelineDurationMs, timelineGeneration } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { aiEditBlockedReason } from "./ai-edit";
import { startAiJob } from "./ai-jobs";
import type { ActingUser } from "./mcp/acting-user";
import { aiProvider, claudeToolTurn, isAiConfigured, isFakeAi } from "./openai";
import { fakeNoteTurn, noteBrief, noteToolSpecs, reelVersions, runNote, type NoteCall } from "./reel-notes";
import { ensureChecks, exportTimeline, type ChecksResult } from "./render-verify";
import { readTimeline } from "./reels";
import { saveReelFor } from "./save-reel";
import { allow } from "./mcp/http";

/**
 * A reel's thread (ADR 0095): its versions (the REEL exports, v1 first) and
 * the notes that made them. Notes are AiEdit rows with `plan.kind: "note"`,
 * so they count against the month's AI requests like Ask and the director,
 * and need no table of their own.
 */

export type NoteStatus = "working" | "exported" | "no-change" | "failed";

export type NotePlan = {
  kind: "note";
  status: NoteStatus;
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

/** A note still marked working after this long lost its server (a deploy) and is shown as failed. */
const STALE_MS = 15 * 60_000;
/** Earlier notes the agent is reminded of. */
const HISTORY = 5;

const asPlan = (value: unknown): NotePlan | null => (value && typeof value === "object" && (value as { kind?: unknown }).kind === "note" ? (value as NotePlan) : null);

function toNote(row: { id: string; request: string; note: string; plan: unknown; applied: unknown; createdAt: Date }, now: number): ThreadNote | null {
  const plan = asPlan(row.plan);
  if (!plan) return null;
  const stale = plan.status === "working" && now - row.createdAt.getTime() > STALE_MS;
  return {
    id: row.id,
    note: row.request,
    reply: stale ? "This note stopped before it finished (the server restarted). Nothing was exported; send it again." : row.note,
    status: stale ? "failed" : plan.status,
    fromExportId: plan.fromExportId,
    toExportId: plan.toExportId,
    applied: Array.isArray(row.applied) ? row.applied.map(String) : [],
    costUsd: plan.costUsd ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function reelNotes(workspaceId: string, reelId: string): Promise<ThreadNote[]> {
  const rows = await prisma.aiEdit.findMany({
    where: { workspaceId, reelId, plan: { path: ["kind"], equals: "note" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, request: true, note: true, plan: true, applied: true, createdAt: true },
  });
  const now = Date.now();
  return rows.map((row) => toNote(row, now)).filter((note): note is ThreadNote => note !== null);
}

/** The thread for the export screen: up to `limit` newest versions with their checks, and every note. */
export async function reelThread(workspaceId: string, reelId: string, options: { limit?: number } = {}): Promise<Thread> {
  const [reel, versions, notes] = await Promise.all([
    prisma.reel.findFirst({ where: { id: reelId, workspaceId }, select: { timeline: true } }),
    reelVersions(workspaceId, reelId),
    reelNotes(workspaceId, reelId),
  ]);
  const shown = versions.slice(-(options.limit ?? 6));
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

/** Notes are offered when Claude (or the stand-in) is there and the month's requests allow one. */
export function notesAvailable(): boolean {
  if (isFakeAi()) return true;
  try {
    return isAiConfigured() && aiProvider() !== "openai";
  } catch {
    return false;
  }
}

export type StartNote = { ok: true; noteId: string; jobId: string } | { ok: false; status: number; message: string; upgrade?: boolean };

/**
 * Starts a note in the background (an AiJob, ADR 0021) and answers at once:
 * a phone that sleeps does not stop it. One note at a time per reel.
 */
export async function startNote(input: { user: ActingUser; reelId: string; note: string; origin: string; requestId: string }): Promise<StartNote> {
  const { user, reelId } = input;
  const note = input.note.trim();
  if (note.length < 3 || note.length > 600) return { ok: false, status: 400, message: "Write the note in a few words (up to 600 characters)." };
  if (!notesAvailable()) return { ok: false, status: 503, message: "Notes need Claude, which is not set up on this deployment." };
  const blocked = await aiEditBlockedReason(user.workspaceId);
  if (blocked) return { ok: false, status: 403, message: blocked.message, upgrade: blocked.upgrade };
  const reel = await prisma.reel.findFirst({ where: { id: reelId, workspaceId: user.workspaceId }, select: { id: true, title: true, revision: true } });
  if (!reel) return { ok: false, status: 404, message: "This reel was deleted." };
  const existing = await prisma.aiJob.findFirst({ where: { id: `note-${input.requestId}`, workspaceId: user.workspaceId }, select: { id: true, result: true } });
  if (existing) {
    const noteId = (existing.result as { noteId?: string } | null)?.noteId;
    const row = noteId ? null : await prisma.aiEdit.findFirst({ where: { workspaceId: user.workspaceId, reelId, plan: { path: ["requestId"], equals: input.requestId } }, select: { id: true } });
    return { ok: true, noteId: noteId ?? row?.id ?? "", jobId: existing.id };
  }
  const [all, notes] = await Promise.all([reelVersions(user.workspaceId, reelId), reelNotes(user.workspaceId, reelId)]);
  if (notes.some((entry) => entry.status === "working")) return { ok: false, status: 409, message: "A note on this reel is still being worked on. Wait for its version." };
  const versions = all.map((version) => ({ label: version.label, exportId: version.id, status: version.status }));
  const latest = versions[versions.length - 1] ?? null;

  const plan: NotePlan & { requestId: string } = { kind: "note", status: "working", fromExportId: latest?.exportId ?? null, toExportId: null, revisionBefore: reel.revision, revisionAfter: null, calls: [], costUsd: 0, requestId: input.requestId };
  const row = await prisma.aiEdit.create({
    data: { workspaceId: user.workspaceId, userId: user.id, reelId, request: note, note: "Working on it", model: "pending", plan, applied: [], skipped: [] },
    select: { id: true },
  });
  const brief = noteBrief({
    title: reel.title,
    reelId,
    revision: reel.revision,
    versions,
    history: notes.filter((entry) => entry.status !== "working").slice(-HISTORY).map((entry) => ({ note: entry.note, reply: entry.reply })),
    note,
  });

  const jobId = await startAiJob({ workspaceId: user.workspaceId, reelId, kind: "note", requestId: input.requestId }, async () => {
    const finish = (data: Partial<NotePlan>, extra: Record<string, unknown>) =>
      prisma.aiEdit.update({ where: { id: row.id }, data: { plan: { ...plan, ...data }, ...extra } });
    try {
      const outcome = await runNote(
        { user, reelId, note, origin: input.origin, brief, exportIds: versions.filter((version) => version.status === "SUCCEEDED").map((version) => version.exportId), revision: reel.revision },
        { turn: isFakeAi() ? fakeNoteTurn : claudeToolTurn, gate: allow, tools: noteToolSpecs() },
      );
      let toExportId: string | null = null;
      let reply = outcome.reply;
      if (outcome.changed) {
        const { queueReelExport } = await import("./export-reel");
        const startedAt = new Date(Date.now() - 1000);
        const queued = await queueReelExport(user, reelId);
        if (queued.ok) {
          toExportId = (await prisma.renderJob.findFirst({ where: { reelId, workspaceId: user.workspaceId, kind: "REEL", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;
        } else {
          const why = queued.message ?? queued.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join(" ");
          reply = `${reply} The new version could not be exported: ${why || "the export was refused"}. The change is saved in the editor.`;
        }
      }
      const status: NoteStatus = toExportId ? "exported" : outcome.changed ? "failed" : "no-change";
      await finish(
        { status, toExportId, revisionAfter: outcome.revisionAfter, calls: outcome.calls, costUsd: outcome.costUsd },
        { note: reply.slice(0, 2000), model: outcome.model, applied: outcome.applied, inputTokens: outcome.usage.inputTokens, cachedTokens: outcome.usage.cachedTokens, outputTokens: outcome.usage.outputTokens },
      );
      // One line per note for the logs and the cost dashboard.
      console.log(JSON.stringify({ event: "reel-note", noteId: row.id, reelId, workspaceId: user.workspaceId, status, model: outcome.model, calls: outcome.calls.length, refused: outcome.calls.filter((call) => call.refused).length, inputTokens: outcome.usage.inputTokens, cachedTokens: outcome.usage.cachedTokens, cacheWriteTokens: outcome.usage.cacheWriteTokens ?? 0, outputTokens: outcome.usage.outputTokens, costUsd: Number(outcome.costUsd.toFixed(4)), toExportId }));
      return { ok: true, noteId: row.id, status, toExportId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finish({ status: "failed", error: message.slice(0, 500) }, { note: `That note did not work: ${message.slice(0, 300)}` }).catch(() => undefined);
      throw error;
    }
  });
  return { ok: true, noteId: row.id, jobId };
}

export type Restore = { ok: true; revision: number; exportId: string } | { ok: false; status: number; message: string };

/**
 * "Back to vN": the reel's cut becomes the timeline that version was rendered
 * from, as one new revision (the editor can undo it like any save). Nothing is
 * rendered: vN's export is already there to post.
 */
export async function restoreVersion(user: { workspaceId: string }, reelId: string, exportId: string): Promise<Restore> {
  const [reel, job] = await Promise.all([
    prisma.reel.findFirst({ where: { id: reelId, workspaceId: user.workspaceId }, select: { revision: true } }),
    prisma.renderJob.findFirst({ where: { id: exportId, reelId, workspaceId: user.workspaceId, kind: "REEL", status: "SUCCEEDED" }, select: { payload: true } }),
  ]);
  if (!reel) return { ok: false, status: 404, message: "This reel was deleted." };
  const timeline = job ? exportTimeline(job.payload) : null;
  if (!timeline) return { ok: false, status: 404, message: "That version is not a finished export of this reel." };
  const saved = await saveReelFor(user, { id: reelId, revision: reel.revision, timeline });
  if (!saved.ok) return { ok: false, status: saved.reason === "conflict" ? 409 : 400, message: saved.message };
  return { ok: true, revision: saved.revision, exportId };
}
