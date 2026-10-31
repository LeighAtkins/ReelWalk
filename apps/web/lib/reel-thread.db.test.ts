/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Notes on a version (ADR 0095) against a real Postgres, with the real
 * monthly allowance (no gate is mocked): the shared reservation under
 * concurrency (Ask and notes racing for the last request, one working note per
 * reel, one note per request id, a retry of the last allowed note), "Go back to
 * vN" as an exact replacement, the export of exactly the revision a note saved,
 * and the fences: a save or an export is checked against the note at the
 * write, records itself in the write's transaction, and is ordered with
 * expiry. The model and the render queue are stand-ins; the database is not.
 * Skipped without DATABASE_URL (a migrated database).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addClips, emptyTimeline, monthStart, parseTimeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { aiEditAllowance, askForChange, reserveAiEdit } from "./ai-edit";
import { runAiStep } from "./ai-steps";
import { commitReelExport, type ExportFence } from "./export-reel";
import { NoteRunError, type NoteOutcome } from "./reel-notes";
import { noteFences, reelNotes, restoreVersion, startNote, type NoteRunDeps, type NoteTiming } from "./reel-thread";
import { withSaveFence } from "./save-fence";
import { saveReelFor } from "./save-reel";

const enabled = Boolean(process.env.DATABASE_URL);
const run = `n${randomBytes(4).toString("hex")}`;
let studios = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh Free studio (5 AI requests a month) and its owner, as the agent acts. */
async function studio() {
  const workspace = await prisma.workspace.create({ data: { slug: `${run}-${studios++}`, name: "Notes" } });
  const row = await prisma.user.create({ data: { email: `${run}-${studios}@example.com`, name: "Owner", workspaceId: workspace.id } });
  return { ...row, workspace, homeWorkspaceId: workspace.id, role: "OWNER" } as any;
}

/** Spends the studio's month down to `left` requests with rows any consumer would have made. */
async function leave(user: any, left: number) {
  const { allowed } = await aiEditAllowance(user.workspaceId);
  const used = await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId, createdAt: { gte: monthStart(new Date()) } } });
  const filler = allowed - left - used;
  expect(filler).toBeGreaterThanOrEqual(0);
  if (filler) await prisma.aiEdit.createMany({ data: Array.from({ length: filler }, () => ({ workspaceId: user.workspaceId, request: "earlier", note: "", plan: {}, applied: [], skipped: [], model: "x" })) });
  return allowed;
}
const usedThisMonth = (user: any) => prisma.aiEdit.count({ where: { workspaceId: user.workspaceId, createdAt: { gte: monthStart(new Date()) } } });

const outcome = (over: Partial<NoteOutcome> = {}): NoteOutcome => ({ reply: "Done.", changed: false, revisionBefore: 0, revisionAfter: 0, applied: [], calls: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }, model: "claude-opus-5-5", costUsd: 0, ...over });

/** A run that waits until released, then does `then`. */
function gated(then: (input: any) => Promise<NoteOutcome> | NoteOutcome = () => outcome()) {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const started: any[] = [];
  const runFn = (async (input: any) => {
    started.push(input);
    await open;
    return then(input);
  }) as NoteRunDeps["run"];
  return { run: runFn, release, started };
}

const SHORT: NoteTiming = { deadlineMs: 1500, saveGuardMs: 500, graceMs: 500 };
const deps = (over: Partial<NoteRunDeps> = {}): NoteRunDeps => ({
  run: (async () => outcome()) as NoteRunDeps["run"],
  tools: {} as any,
  queueExport: async () => ({ ok: false, issues: [], message: "not in this test" }),
  timing: { deadlineMs: 600_000, saveGuardMs: 30_000, graceMs: 60_000 },
  ...over,
});
/** The real export transaction (job, outbox message, the note's fence) with a stand-in payload; no render is started. */
const realExport: NoteRunDeps["queueExport"] = (user, reelId, options) => commitReelExport({ user, reelId, payload: { timeline: emptyTimeline(), assets: {}, output: { width: 720, watermark: true } }, caption: "Fit", ...options });

const newReel = async (user: any, timeline: unknown = emptyTimeline()) => (await prisma.reel.create({ data: { workspaceId: user.workspaceId, title: "Fit", timeline: timeline as any } })).id;
const note = (user: any, reelId: string, d: NoteRunDeps, requestId = randomUUID(), words = "show the desk earlier") => startNote({ user, reelId, note: words, origin: "http://test", requestId }, d);
const notesOf = (reelId: string) => prisma.aiEdit.findMany({ where: { reelId, plan: { path: ["kind"], equals: "note" } }, orderBy: { createdAt: "asc" } });
/** A save the way the agent's apply_commands makes one, inside the note's fence. */
const agentSave = async (user: any, reelId: string, fence: ReturnType<typeof noteFences>, line = "splitClip {}") => {
  const reel = await prisma.reel.findUniqueOrThrow({ where: { id: reelId } });
  fence.applying([line]);
  return withSaveFence(fence.save, () => saveReelFor(user, { id: reelId, revision: reel.revision, timeline: addClips(parseTimeline(reel.timeline), []) }));
};

describe.skipIf(!enabled)("notes on a version against a real database", () => {
  beforeAll(() => {
    vi.stubEnv("DEV_FAKE_AI", "true");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("AI_PROVIDER", "");
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { slug: { startsWith: run } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: run } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  describe("the month's allowance, shared by every AI request", () => {
    it("never passes the allowance, however many reservations race for it", async () => {
      const user = await studio();
      const allowed = await leave(user, 3);
      const answers = await Promise.all(Array.from({ length: 10 }, () => reserveAiEdit(user.workspaceId, (tx) => tx.aiEdit.create({ data: { workspaceId: user.workspaceId, request: "x", note: "", plan: {}, applied: [], skipped: [], model: "x" } }))));
      expect(answers.filter((answer) => answer.ok)).toHaveLength(3);
      expect(await usedThisMonth(user)).toBe(allowed);
    });

    it("gives the last request to exactly one of an Ask and a note racing for it", async () => {
      for (let round = 0; round < 4; round++) {
        const user = await studio();
        const allowed = await leave(user, 1);
        const reelId = await newReel(user);
        const [asked, noted] = await Promise.all([
          askForChange({ user, reel: { id: reelId, title: "Fit" }, timeline: emptyTimeline(), request: "make it warmer" }),
          note(user, reelId, deps()),
        ]);
        expect([asked.ok, noted.ok].filter(Boolean)).toHaveLength(1);
        expect(await usedThisMonth(user)).toBe(allowed);
        if (noted.ok) await noted.settled;
      }
    });

    it("an Ask after a note took the last request is refused by the allowance, and so is a note after an Ask", async () => {
      const first = await studio();
      await leave(first, 1);
      const reelA = await newReel(first);
      const noted = await note(first, reelA, deps());
      expect(noted.ok).toBe(true);
      const asked = await askForChange({ user: first, reel: { id: reelA, title: "Fit" }, timeline: emptyTimeline(), request: "make it warmer" });
      expect(asked).toMatchObject({ ok: false, message: expect.stringContaining("free requests") });
      await (noted as any).settled;

      const second = await studio();
      const allowed = await leave(second, 1);
      const reelB = await newReel(second);
      expect((await askForChange({ user: second, reel: { id: reelB, title: "Fit" }, timeline: emptyTimeline(), request: "make it warmer" })).ok).toBe(true);
      expect(await note(second, reelB, deps())).toMatchObject({ ok: false, status: 403 });
      expect(await usedThisMonth(second)).toBe(allowed);
    });

    it("a retry of the last allowed note gets the same note, not a refusal", async () => {
      const user = await studio();
      const allowed = await leave(user, 1);
      const reelId = await newReel(user);
      const requestId = randomUUID();
      const gate = gated();
      const first = await note(user, reelId, deps({ run: gate.run }), requestId);
      expect(first.ok).toBe(true);
      const retries = await Promise.all(Array.from({ length: 3 }, () => note(user, reelId, deps({ run: gate.run }), requestId)));
      expect(retries.map((answer) => (answer as any).noteId)).toEqual([0, 1, 2].map(() => (first as any).noteId));
      expect(await note(user, reelId, deps(), requestId, "other words")).toMatchObject({ ok: false, status: 409 });
      expect(await usedThisMonth(user)).toBe(allowed);
      gate.release();
      await (first as any).settled;
    });
  });

  describe("one note per reel", () => {
    it("lets one of several simultaneous notes on a reel start, and only one agent runs", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const gate = gated();
      const answers = await Promise.all(Array.from({ length: 6 }, () => note(user, reelId, deps({ run: gate.run }))));
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      expect(answers.filter((answer) => !answer.ok).map((answer) => (answer as any).status)).toEqual([409, 409, 409, 409, 409]);
      expect(await notesOf(reelId)).toHaveLength(1);
      await vi.waitFor(() => expect(gate.started).toHaveLength(1));
      gate.release();
      await (answers.find((answer) => answer.ok) as any).settled;
    });
  });

  describe("the version a note exports", () => {
    it("is the revision the note saved, and nothing is exported when the owner saved after it", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const runFn = (async (input: any) => {
        await prisma.reel.update({ where: { id: reelId }, data: { revision: { increment: 1 } } });
        await prisma.reel.update({ where: { id: reelId }, data: { revision: { increment: 1 } } }); // the owner's own save
        return outcome({ changed: true, revisionBefore: input.revision, revisionAfter: input.revision + 1 });
      }) as NoteRunDeps["run"];
      await (await note(user, reelId, deps({ run: runFn, queueExport: realExport })) as any).settled;
      const [row] = await notesOf(reelId);
      expect(row.plan as any).toMatchObject({ status: "saved", toExportId: null });
      expect(await prisma.renderJob.count({ where: { reelId } })).toBe(0);
    });

    it("records the job it created, in the job's own transaction", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const runFn = (async (input: any) => outcome({ changed: true, revisionAfter: input.revision })) as NoteRunDeps["run"];
      await (await note(user, reelId, deps({ run: runFn, queueExport: realExport })) as any).settled;
      const [row] = await notesOf(reelId);
      const jobs = await prisma.renderJob.findMany({ where: { reelId } });
      expect(jobs).toHaveLength(1);
      expect(row.plan as any).toMatchObject({ status: "exported", toExportId: jobs[0].id });
      // Its queue message went into the outbox in the same transaction.
      expect(await prisma.outboxMessage.count({ where: { body: { contains: jobs[0].id } } })).toBe(1);
    });
  });

  describe("a create run (ADR 0098)", () => {
    it("runs with its own tools and brief, puts its caption on the reel, shows the owner the reply without it, and exports", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const seen: any[] = [];
      const createTools = { marker: "create" } as any;
      const runFn = (async (input: any, tools: any) => {
        seen.push({ input, tools });
        return outcome({ changed: true, revisionAfter: input.revision, reply: "Six stock shots of the beach, cut fast.\nCaption: Morning at the beach. #beach #home" });
      }) as NoteRunDeps["run"];
      const started = await startNote({ user, reelId, note: "Five reasons to live by the beach", origin: "http://test", requestId: randomUUID(), create: { brief: "the create brief" } }, deps({ run: runFn, queueExport: realExport, createTools }));
      await (started as any).settled;
      expect(seen[0].input).toMatchObject({ mode: "create", brief: "the create brief", note: "Five reasons to live by the beach" });
      expect(seen[0].tools).toBe(createTools);
      const [row] = await notesOf(reelId);
      expect(row.plan as any).toMatchObject({ kind: "note", mode: "create", status: "exported" });
      expect(row.request).toBe("Five reasons to live by the beach");
      expect(row.note).toBe("Six stock shots of the beach, cut fast.");
      expect((await prisma.reel.findUniqueOrThrow({ where: { id: reelId } })).caption).toBe("Morning at the beach. #beach #home");
    });

    it("never overwrites a caption the owner already wrote", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      await prisma.reel.update({ where: { id: reelId }, data: { caption: "Mine" } });
      const runFn = (async (input: any) => outcome({ changed: true, revisionAfter: input.revision, reply: "Done.\nCaption: Theirs" })) as NoteRunDeps["run"];
      await ((await startNote({ user, reelId, note: "A day at our cafe, cosy and warm", origin: "http://test", requestId: randomUUID(), create: { brief: "b" } }, deps({ run: runFn, queueExport: realExport }))) as any).settled;
      expect((await prisma.reel.findUniqueOrThrow({ where: { id: reelId } })).caption).toBe("Mine");
    });
  });

  describe("the fences: checked at the write, recorded with it, ordered with expiry", () => {
    it("a save records its revision and lines in its own transaction, so a run that dies after it still shows it", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const runFn = (async () => {
        const fence = noteFences((await notesOf(reelId))[0].id);
        expect((await agentSave(user, reelId, fence)).ok).toBe(true);
        throw new Error("the web process restarted"); // before the run could report anything
      }) as NoteRunDeps["run"];
      const started = await note(user, reelId, deps({ run: runFn, timing: SHORT }));
      await (started as any).settled;
      const [row] = await notesOf(reelId);
      expect(row.plan as any).toMatchObject({ revisionAfter: 1 });
      expect(row.applied).toEqual(["splitClip {}"]);
      await sleep(SHORT.deadlineMs + SHORT.graceMs + 300);
      // Its status was settled as failed (nothing in the run's own outcome), but the facts are there; an expiry would read them.
      const [shown] = await reelNotes(user.workspaceId, reelId);
      expect(shown.applied).toEqual(["splitClip {}"]);
    });

    it("refuses a save that reaches the write after saveBy, by the database's clock, even if it was let through earlier", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const results: unknown[] = [];
      const runFn = (async () => {
        const fence = noteFences((await notesOf(reelId))[0].id);
        await sleep(SHORT.deadlineMs - SHORT.saveGuardMs + 200); // a slow tool: past saveBy when it writes
        results.push(await agentSave(user, reelId, fence));
        return outcome();
      }) as NoteRunDeps["run"];
      await (await note(user, reelId, deps({ run: runFn, timing: SHORT })) as any).settled;
      expect(results[0]).toMatchObject({ ok: false, reason: "fenced", message: expect.stringContaining("out of time") });
      expect((await prisma.reel.findUniqueOrThrow({ where: { id: reelId } })).revision).toBe(0);
    });

    it("refuses a save after the note was expired, and the expiry's words follow what the note had committed", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const held: { fence?: ReturnType<typeof noteFences> } = {};
      const results: unknown[] = [];
      const gate = gated(async () => {
        results.push(await agentSave(user, reelId, held.fence!, "deleteClip {}"));
        return outcome();
      });
      const started = await note(user, reelId, deps({ run: gate.run, timing: { deadlineMs: 1500, saveGuardMs: 0, graceMs: 500 } }));
      held.fence = noteFences((started as any).noteId);
      expect((await agentSave(user, reelId, held.fence)).ok).toBe(true); // one save inside the window
      await sleep(2300);
      const [expired] = await reelNotes(user.workspaceId, reelId);
      expect(expired).toMatchObject({ status: "expired", reply: expect.stringContaining("saving its change (revision 1)") });
      gate.release();
      await (started as any).settled;
      expect(results[0]).toMatchObject({ ok: false, reason: "fenced", message: expect.stringContaining("stopped") });
      expect((await prisma.reel.findUniqueOrThrow({ where: { id: reelId } })).revision).toBe(1);
    });

    it("an export holding the note's row is never overtaken by expiry: it commits, then the note expires with the version recorded", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const gate = gated();
      const started = await note(user, reelId, deps({ run: gate.run, timing: { deadlineMs: 1000, saveGuardMs: 200, graceMs: 600 } }));
      const fence = noteFences((started as any).noteId);
      await sleep(1100); // past the deadline, before expiresAt (1600 ms)
      const exporting = prisma.$transaction(async (tx) => {
        expect(await fence.exporting.lock(tx)).toBeNull(); // locks the note
        expect(await fence.exporting.inTime(tx)).toBeNull();
        await sleep(1300); // still writing the job when expiresAt passes (and when the read below happens)
        await fence.exporting.committed(tx, "job-held");
      });
      await sleep(600);
      const expiring = reelNotes(user.workspaceId, reelId); // eligible now, but must wait for the export's lock
      await sleep(250);
      // Read without a lock while the export still holds the row: the expiry has not overtaken it.
      expect(((await prisma.aiEdit.findUniqueOrThrow({ where: { id: (started as any).noteId } })).plan as any).status).toBe("working");
      await exporting;
      await expiring;
      const [row] = await notesOf(reelId);
      expect(row.plan as any).toMatchObject({ status: "expired", toExportId: "job-held" });
      expect((await reelNotes(user.workspaceId, reelId))[0].reply).toContain("after its version was queued");
      gate.release();
      await (started as any).settled;
    });

    it("an export that reaches the write after expiresAt creates no job", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const runFn = (async (input: any) => {
        await sleep(1700); // the run outlives expiresAt (1500 ms) before its export
        return outcome({ changed: true, revisionAfter: input.revision });
      }) as NoteRunDeps["run"];
      await (await note(user, reelId, deps({ run: runFn, queueExport: realExport, timing: { deadlineMs: 1000, saveGuardMs: 200, graceMs: 500 } })) as any).settled;
      expect(await prisma.renderJob.count({ where: { reelId } })).toBe(0);
      expect((await notesOf(reelId))[0].plan as any).toMatchObject({ toExportId: null });
    });

    it("logs the note's cost even when recording it fails", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
      try {
        const runFn = (async () => {
          await prisma.aiEdit.deleteMany({ where: { reelId } }); // the record is gone when the run reports
          throw new NoteRunError("Claude could not answer (HTTP 529).", outcome({ usage: { inputTokens: 5000, cachedTokens: 0, outputTokens: 10, cacheWriteTokens: 0 }, costUsd: 0.0202 }));
        }) as NoteRunDeps["run"];
        await (await note(user, reelId, deps({ run: runFn })) as any).settled;
      } finally {
        spy.mockRestore();
      }
      const line = lines.map((text) => { try { return JSON.parse(text); } catch { return null; } }).find((entry) => entry?.event === "reel-note");
      expect(line).toMatchObject({ costUsd: 0.0202, inputTokens: 5000, failure: expect.stringContaining("recording the note failed") });
    });
  });

  describe("lock waits and the clock (round 3)", () => {
    /** Holds the reel's row lock, as another writer would, for `ms`. */
    const holdReel = (reelId: string, ms: number) =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM "Reel" WHERE id = ${reelId} FOR UPDATE`;
        await sleep(ms);
      }, { timeout: 10_000 });

    it("a save that starts before saveBy but waits on the reel's lock until after it is refused, by the clock at the write", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const gate = gated();
      // saveBy at 1000 ms, expiry at 2000 ms.
      const started = await note(user, reelId, deps({ run: gate.run, timing: { deadlineMs: 1500, saveGuardMs: 500, graceMs: 500 } }));
      const fence = noteFences((started as any).noteId);
      const holding = holdReel(reelId, 1300); // another writer holds the reel from ~0 to ~1300 ms
      await sleep(300);
      const saved = await agentSave(user, reelId, fence); // starts at ~300 ms (inside saveBy), waits until ~1300 ms
      await holding;
      expect(saved).toMatchObject({ ok: false, reason: "fenced", message: expect.stringContaining("out of time") });
      expect((await prisma.reel.findUniqueOrThrow({ where: { id: reelId } })).revision).toBe(0);
      expect((await notesOf(reelId))[0].applied).toEqual([]);
      gate.release();
      await (started as any).settled;
    });

    it("an export that starts before expiresAt but waits on the reel's lock until after it creates no job", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      const gate = gated();
      // expiresAt at 1000 ms.
      const started = await note(user, reelId, deps({ run: gate.run, timing: { deadlineMs: 600, saveGuardMs: 200, graceMs: 400 } }));
      const fence = noteFences((started as any).noteId);
      const holding = holdReel(reelId, 1300);
      await sleep(300);
      const exported = await realExport(user, reelId, { revision: 0, fence: fence.exporting });
      await holding;
      expect(exported).toMatchObject({ ok: false, fenced: true });
      expect(await prisma.renderJob.count({ where: { reelId } })).toBe(0);
      expect((await notesOf(reelId))[0].plan as any).toMatchObject({ toExportId: null });
      gate.release();
      await (started as any).settled;
    });

    it("an owner's save cannot land between the export's revision check and its job: it waits for the export", async () => {
      const user = await studio();
      const reelId = await newReel(user);
      let ownerDone = false;
      let owner: Promise<unknown> | null = null;
      const fence: ExportFence = {
        lock: async () => null,
        // Called after the reel's revision was checked, right before the job: the owner saves now.
        inTime: async () => {
          if (!owner) {
            owner = prisma.reel.updateMany({ where: { id: reelId }, data: { revision: { increment: 1 } } }).then(() => void (ownerDone = true));
            await sleep(500);
          }
          return null;
        },
        committed: async () => undefined,
      };
      const exported = await realExport(user, reelId, { revision: 0, fence });
      const doneDuringExport = ownerDone;
      await owner;
      expect(exported.ok).toBe(true);
      expect(doneDuringExport).toBe(false); // held off by the export's lock on the reel
      expect((await prisma.reel.findUniqueOrThrow({ where: { id: reelId } })).revision).toBe(1); // and landed after it
    });

    it("a replayed durable step reserves once: the replay reuses its request instead of taking (or being refused) another", async () => {
      const user = await studio();
      const allowed = await leave(user, 1);
      const reelId = await newReel(user);
      const step = { kind: "ask" as const, user: { id: user.id, workspaceId: user.workspaceId }, reelId, payload: { request: "make it warmer", timeline: emptyTimeline(), answers: [] }, identity: "step:s1:g1" };
      const first = (await runAiStep(step)) as { ok: boolean };
      const replay = (await runAiStep(step)) as { ok: boolean }; // the worker died before submitting; ADR 0049 requeued it
      expect(first.ok).toBe(true);
      expect(replay.ok).toBe(true);
      expect(await usedThisMonth(user)).toBe(allowed);
      expect(await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId, plan: { path: ["reservation"], equals: "step:s1:g1" } } })).toBe(1);
      // A different request (or a new generation of the step) is a new request, and the month is spent.
      expect(((await runAiStep({ ...step, identity: "step:s1:g2" })) as { ok: boolean; message?: string })).toMatchObject({ ok: false, message: expect.stringContaining("free requests") });
    });

    it("counts a request in the month its own timestamp is in: one database timestamp decides both", async () => {
      const user = await studio();
      const { allowed } = await aiEditAllowance(user.workspaceId);
      const lastOfOctober = new Date("2026-10-31T23:59:59.999Z");
      await prisma.aiEdit.createMany({ data: Array.from({ length: allowed }, () => ({ workspaceId: user.workspaceId, request: "october", note: "", plan: {}, applied: [], skipped: [], model: "x", createdAt: new Date("2026-10-15T00:00:00Z") })) });
      const create = (tx: any, stamp: { now: Date }) => tx.aiEdit.create({ data: { workspaceId: user.workspaceId, request: "x", note: "", plan: {}, applied: [], skipped: [], model: "x", createdAt: stamp.now }, select: { id: true } });
      // A millisecond before midnight UTC: October is full.
      expect(await reserveAiEdit(user.workspaceId, create, { at: lastOfOctober })).toMatchObject({ ok: false, blocked: expect.anything() });
      // At midnight: November, and the row is stamped November, the month it was counted in.
      const november = await reserveAiEdit(user.workspaceId, create, { at: new Date("2026-11-01T00:00:00.000Z") });
      expect(november.ok).toBe(true);
      const row = await prisma.aiEdit.findUniqueOrThrow({ where: { id: (november as any).value.id } });
      expect(row.createdAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
      // Without an override, the row's stamp is the reservation's own database timestamp.
      const fresh = await studio();
      const now = await reserveAiEdit(fresh.workspaceId, (tx, stamp) => tx.aiEdit.create({ data: { workspaceId: fresh.workspaceId, request: "x", note: "", plan: {}, applied: [], skipped: [], model: "x", createdAt: stamp.now }, select: { id: true } }));
      expect(now.ok).toBe(true);
      expect((await prisma.aiEdit.findUniqueOrThrow({ where: { id: (now as any).value.id } })).createdAt.getTime()).toBe((now as any).at.getTime());
    });
  });

  describe("going back to a version", () => {
    it("replaces the cut exactly: text styling the version never had does not survive", async () => {
      const user = await studio();
      const text = { id: "t1", text: "Will it fit?", startMs: 0, endMs: 2000, x: 0.3, y: 0.2, style: "elegant" };
      const v1 = parseTimeline({ ...emptyTimeline(), texts: [text] });
      const v2 = parseTimeline({ ...emptyTimeline(), texts: [{ ...text, font: "tight", blend: "invert" }] });
      const reelId = await newReel(user, v2);
      const job = await prisma.renderJob.create({ data: { workspaceId: user.workspaceId, reelId, kind: "REEL", status: "SUCCEEDED", payload: { timeline: v1, assets: {}, output: { width: 1080, watermark: false } } as any } });
      expect((await restoreVersion(user, reelId, job.id)).ok).toBe(true);
      const saved = parseTimeline((await prisma.reel.findUniqueOrThrow({ where: { id: reelId } })).timeline);
      expect(saved.texts[0].font).toBeUndefined();
      expect(saved.texts[0].blend).toBeUndefined();
    });
  });
});
