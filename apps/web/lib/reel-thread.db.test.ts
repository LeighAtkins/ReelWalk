/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Notes on a version (ADR 0095) against a real Postgres: the reservation under
 * concurrency (one working note per reel, the month's allowance, one note per
 * request id), "Go back to vN" as an exact replacement, the export of exactly
 * the revision a note saved, what a failed or expired run records. The model
 * and the export queue are stand-ins; everything else is the real code.
 * Skipped without DATABASE_URL (a migrated database).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTimeline, parseTimeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";

const quota = vi.hoisted(() => ({ allowed: 1000 }));
vi.mock("./ai-edit", () => ({
  aiEditBlockedReason: async () => null,
  aiEditAllowance: async () => ({ allowed: quota.allowed, unlimited: false }),
}));

import { NoteRunError, type NoteOutcome } from "./reel-notes";
import { NOTE_DEADLINE_MS, NOTE_EXPIRY_GRACE_MS, reelNotes, restoreVersion, startNote, type NoteRunDeps } from "./reel-thread";
import { queueReelExport } from "./export-reel";

const enabled = Boolean(process.env.DATABASE_URL);
const run = `n${randomBytes(4).toString("hex")}`;
let user: any;

const outcome = (over: Partial<NoteOutcome> = {}): NoteOutcome => ({ reply: "Done.", changed: false, revisionBefore: 0, revisionAfter: 0, applied: [], calls: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }, model: "claude-opus-5-5", costUsd: 0, ...over });

/** A run that waits until released, then answers `answer`. */
function gated(answer: (input: any) => Promise<NoteOutcome> | NoteOutcome = () => outcome()) {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const started: any[] = [];
  const run = (async (input: any) => {
    started.push(input);
    await open;
    return answer(input);
  }) as NoteRunDeps["run"];
  return { run, release, started };
}

const deps = (over: Partial<NoteRunDeps> = {}): NoteRunDeps => ({
  run: (async () => outcome()) as NoteRunDeps["run"],
  tools: {} as any,
  queueExport: async () => ({ ok: false, issues: [], message: "not in this test" }),
  now: Date.now,
  ...over,
});

const newReel = async (timeline: unknown = emptyTimeline()) => (await prisma.reel.create({ data: { workspaceId: user.workspaceId, title: "Fit", timeline: timeline as any } })).id;
const note = (reelId: string, d: NoteRunDeps, requestId = randomUUID(), words = "show the desk earlier") => startNote({ user, reelId, note: words, origin: "http://test", requestId }, d);
const notesOf = (reelId: string) => prisma.aiEdit.findMany({ where: { reelId }, orderBy: { createdAt: "asc" } });

describe.skipIf(!enabled)("notes on a version against a real database", () => {
  beforeAll(async () => {
    vi.stubEnv("DEV_FAKE_AI", "true");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const workspace = await prisma.workspace.create({ data: { slug: run, name: "Notes" } });
    const row = await prisma.user.create({ data: { email: `${run}@example.com`, name: "Owner", workspaceId: workspace.id } });
    user = { ...row, workspace, homeWorkspaceId: workspace.id, role: "OWNER" };
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { slug: run } });
    await prisma.user.deleteMany({ where: { email: `${run}@example.com` } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    quota.allowed = 1000;
  });

  describe("the reservation", () => {
    it("lets one of several simultaneous notes on a reel start, and only one agent runs", async () => {
      const reelId = await newReel();
      const gate = gated();
      const answers = await Promise.all(Array.from({ length: 6 }, () => note(reelId, deps({ run: gate.run }))));
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      expect(answers.filter((answer) => !answer.ok).map((answer) => (answer as any).status)).toEqual([409, 409, 409, 409, 409]);
      expect(await notesOf(reelId)).toHaveLength(1);
      expect(await prisma.aiJob.count({ where: { reelId } })).toBe(1);
      await vi.waitFor(() => expect(gate.started).toHaveLength(1));
      gate.release();
      await (answers.find((answer) => answer.ok) as any).settled;
      expect(gate.started).toHaveLength(1);
    });

    it("never lets parallel notes go past the month's allowance", async () => {
      const used = await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId } });
      quota.allowed = used + 2;
      const reels = await Promise.all(Array.from({ length: 5 }, () => newReel()));
      const answers = await Promise.all(reels.map((reelId) => note(reelId, deps())));
      expect(answers.filter((answer) => answer.ok)).toHaveLength(2);
      expect(answers.filter((answer) => !answer.ok).every((answer) => (answer as any).status === 403)).toBe(true);
      await Promise.all(answers.map((answer) => (answer.ok ? answer.settled : null)));
      expect(await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId } })).toBe(used + 2);
    });

    it("gives every retry of one request id the same note, and refuses the id for another reel or other words", async () => {
      const reelId = await newReel();
      const requestId = randomUUID();
      const gate = gated();
      const answers = await Promise.all(Array.from({ length: 4 }, () => note(reelId, deps({ run: gate.run }), requestId)));
      expect(answers.every((answer) => answer.ok)).toBe(true);
      expect(new Set(answers.map((answer) => (answer as any).noteId)).size).toBe(1);
      expect(await notesOf(reelId)).toHaveLength(1);
      expect(await prisma.aiJob.count({ where: { id: `note-${requestId}` } })).toBe(1);
      expect(await note(await newReel(), deps(), requestId)).toMatchObject({ ok: false, status: 409 });
      expect(await note(reelId, deps(), requestId, "something else")).toMatchObject({ ok: false, status: 409 });
      gate.release();
      await Promise.all(answers.map((answer) => (answer as any).settled));
    });
  });

  describe("the version a note exports", () => {
    it("is the revision the note saved, and nothing is exported when the owner saved after it", async () => {
      const reelId = await newReel();
      const run = (async (input: any) => {
        // The agent's save, then the owner's own edit before the export.
        await prisma.reel.update({ where: { id: reelId }, data: { revision: { increment: 1 } } });
        await prisma.reel.update({ where: { id: reelId }, data: { revision: { increment: 1 } } });
        return outcome({ changed: true, revisionBefore: input.revision, revisionAfter: input.revision + 1 });
      }) as NoteRunDeps["run"];
      const started = await note(reelId, deps({ run, queueExport: (u, id, options) => queueReelExport(u, id, options) }));
      await (started as any).settled;
      const [row] = await notesOf(reelId);
      expect((row.plan as any).status).toBe("saved");
      expect((row.plan as any).toExportId).toBeNull();
      expect(row.note).toContain("edited while the note was being worked on");
      expect(await prisma.renderJob.count({ where: { reelId } })).toBe(0);
    });

    it("is the job the export created, not the newest one", async () => {
      const reelId = await newReel();
      let created = "";
      const queueExport: NoteRunDeps["queueExport"] = async () => {
        created = (await prisma.renderJob.create({ data: { workspaceId: user.workspaceId, reelId, kind: "REEL" } })).id;
        // Someone else's export a moment later.
        await prisma.renderJob.create({ data: { workspaceId: user.workspaceId, reelId, kind: "REEL", createdAt: new Date(Date.now() + 500) } });
        return { ok: true, jobId: created };
      };
      const started = await note(reelId, deps({ run: (async (input: any) => outcome({ changed: true, revisionAfter: input.revision + 1 })) as NoteRunDeps["run"], queueExport }));
      await (started as any).settled;
      const [row] = await notesOf(reelId);
      expect((row.plan as any)).toMatchObject({ status: "exported", toExportId: created });
    });
  });

  describe("a run that fails or outlives its deadline", () => {
    it("records the saved change, its tokens and its cost when the model fails after saving, and still exports it", async () => {
      const reelId = await newReel();
      const run = (async (input: any) => {
        await input.onSaved({ revisionAfter: input.revision + 1, applied: ["splitClip {}"] });
        throw new NoteRunError("Claude could not answer (HTTP 529).", outcome({ changed: true, revisionBefore: input.revision, revisionAfter: input.revision + 1, applied: ["splitClip {}"], usage: { inputTokens: 1234, cachedTokens: 600, outputTokens: 99, cacheWriteTokens: 0 }, costUsd: 0.0123 }));
      }) as NoteRunDeps["run"];
      const started = await note(reelId, deps({ run, queueExport: async () => ({ ok: true, jobId: "job-x" }) }));
      await (started as any).settled;
      const [row] = await notesOf(reelId);
      expect(row).toMatchObject({ model: "claude-opus-5-5", inputTokens: 1234, cachedTokens: 600, outputTokens: 99, applied: ["splitClip {}"] });
      expect(row.plan as any).toMatchObject({ status: "exported", toExportId: "job-x", costUsd: 0.0123, error: expect.stringContaining("529") });
      expect(row.note).toContain("stopped before summing it up");
    });

    it("expires a note past its deadline for good, frees the reel, and fences the old run's saves and export", async () => {
      const reelId = await newReel();
      let clock = Date.now();
      const exports: unknown[] = [];
      const refusals: (string | null)[] = [];
      const gate = gated(async (input: any) => {
        refusals.push(await input.beforeSave());
        return outcome({ changed: true, revisionBefore: input.revision, revisionAfter: input.revision + 1 });
      });
      const first = await note(reelId, deps({ run: gate.run, now: () => clock, queueExport: async (...args) => (exports.push(args), { ok: true, jobId: "late" }) }));
      expect(first.ok).toBe(true);
      expect(await note(reelId, deps({ now: () => clock }))).toMatchObject({ ok: false, status: 409 });

      clock += NOTE_DEADLINE_MS + NOTE_EXPIRY_GRACE_MS + 1;
      const shown = await reelNotes(user.workspaceId, reelId, { now: clock });
      expect(shown[0]).toMatchObject({ status: "expired", reply: expect.stringContaining("before it changed anything") });
      expect(((await notesOf(reelId))[0].plan as any).status).toBe("expired");
      const second = await note(reelId, deps({ now: () => clock }));
      expect(second.ok).toBe(true);
      await (second as any).settled;

      gate.release();
      await (first as any).settled;
      expect(refusals[0]).toMatch(/out of time|stopped/);
      expect(exports).toEqual([]);
      const [old] = await notesOf(reelId);
      expect((old.plan as any).status).toBe("expired");
    });
  });

  describe("going back to a version", () => {
    it("replaces the cut exactly: text styling the version never had does not survive", async () => {
      const text = { id: "t1", text: "Will it fit?", startMs: 0, endMs: 2000, x: 0.3, y: 0.2, style: "elegant" };
      const v1 = parseTimeline({ ...emptyTimeline(), texts: [text] });
      const v2 = parseTimeline({ ...emptyTimeline(), texts: [{ ...text, font: "tight", blend: "invert" }] });
      expect(v2.texts[0]).toMatchObject({ font: "tight", blend: "invert" });
      const reelId = await newReel(v2);
      const job = await prisma.renderJob.create({ data: { workspaceId: user.workspaceId, reelId, kind: "REEL", status: "SUCCEEDED", payload: { timeline: v1, assets: {}, output: { width: 1080, watermark: false } } as any } });
      const restored = await restoreVersion(user, reelId, job.id);
      expect(restored.ok).toBe(true);
      const saved = parseTimeline((await prisma.reel.findUniqueOrThrow({ where: { id: reelId } })).timeline);
      expect(saved.texts[0].font).toBeUndefined();
      expect(saved.texts[0].blend).toBeUndefined();
      expect(saved.texts[0].text).toBe("Will it fit?");
    });
  });
});
