/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Create's request ids (ADR 0098) against a real Postgres, with the real
 * monthly allowance and the real note reservation: a retried POST (its answer
 * lost, Try again, two tabs at once) gets the same reels and notes and spends
 * the allowance once; a request stopped part-way resumes where it stopped; the
 * same id with another payload is refused. The model's run is a stand-in.
 * Skipped without DATABASE_URL.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { monthStart } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { aiEditAllowance } from "./ai-edit";
import { createOptionIds, startCreate, type CreateDeps } from "./create-reels";
import type { NoteOutcome } from "./reel-notes";
import { startNote, type NoteRunDeps } from "./reel-thread";

const enabled = Boolean(process.env.DATABASE_URL);
const run = `cr${randomBytes(4).toString("hex")}`;
let studios = 0;
const idea = "Five reasons buyers love living near the beach in Cronulla.";

async function studio() {
  const workspace = await prisma.workspace.create({ data: { slug: `${run}-${studios++}`, name: "Create" } });
  const row = await prisma.user.create({ data: { email: `${run}-${studios}@example.com`, name: "Owner", workspaceId: workspace.id } });
  return { ...row, workspace, homeWorkspaceId: workspace.id, role: "OWNER" } as any;
}

/** Spends the month down to `left` requests with rows any AI request would have made; returns them so they can be given back. */
async function leave(user: any, left: number) {
  const { allowed } = await aiEditAllowance(user.workspaceId);
  const used = await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId, createdAt: { gte: monthStart(new Date()) } } });
  const filler = allowed - left - used;
  expect(filler).toBeGreaterThanOrEqual(0);
  await prisma.aiEdit.createMany({ data: Array.from({ length: filler }, () => ({ workspaceId: user.workspaceId, request: "earlier", note: "", plan: {}, applied: [], skipped: [], model: "x" })) });
}

const outcome = (): NoteOutcome => ({ reply: "Done.\nCaption: Hi", changed: false, revisionBefore: 0, revisionAfter: 0, applied: [], calls: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }, model: "claude-opus-5-5", costUsd: 0 });
const noteDeps: NoteRunDeps = {
  run: (async () => outcome()) as NoteRunDeps["run"],
  tools: {} as any,
  createTools: {} as any,
  queueExport: async () => ({ ok: false, issues: [], message: "not in this test" }),
  timing: { deadlineMs: 600_000, saveGuardMs: 30_000, graceMs: 60_000 },
};

/** The real startNote with the stand-in run; every background run is kept so the test can wait for it. */
function deps(over: { beforeNote?: (input: any) => Promise<void> } = {}): CreateDeps & { settled: Promise<unknown>[]; calls: number } {
  const state = { settled: [] as Promise<unknown>[], calls: 0 };
  return Object.assign(state, {
    startNote: (async (input: any) => {
      state.calls++;
      await over.beforeNote?.(input);
      const started = await startNote(input, noteDeps);
      if (started.ok) state.settled.push(started.settled);
      return started;
    }) as CreateDeps["startNote"],
  });
}

const ask = (user: any, requestId: string, d: CreateDeps, over: Record<string, unknown> = {}) =>
  startCreate({ user, requestId, idea, mediaIds: [], options: 3, captions: true, origin: "http://test", ...over }, d);
const reelsOf = (user: any) => prisma.reel.findMany({ where: { workspaceId: user.workspaceId }, select: { id: true }, orderBy: { id: "asc" } });
const notesOf = (user: any) => prisma.aiEdit.findMany({ where: { workspaceId: user.workspaceId, plan: { path: ["kind"], equals: "note" } }, select: { id: true, reelId: true } });

describe.skipIf(!enabled)("Create's request ids against a real database", () => {
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

  it("answers a retry after a lost response with the same reels and notes, and spends the allowance once", async () => {
    const user = await studio();
    const requestId = randomUUID();
    const first = deps();
    const answered = await ask(user, requestId, first);
    expect(answered).toMatchObject({ ok: true, skipped: 0 });
    // The answer is lost; the browser sends the same request again.
    const again = deps();
    const retried = await ask(user, requestId, again);
    expect(retried).toEqual(answered);
    await Promise.all([...first.settled, ...again.settled]);
    expect(await reelsOf(user)).toHaveLength(3);
    expect(await notesOf(user)).toHaveLength(3);
    expect(await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId } })).toBe(3);
    expect(await prisma.workflowRun.count({ where: { workspaceId: user.workspaceId, kind: "create" } })).toBe(1);
    expect((await prisma.workflowRun.findFirstOrThrow({ where: { workspaceId: user.workspaceId, kind: "create" } })).status).toBe("SUCCEEDED");
  });

  it("gives two concurrent sends of one request the same three options, one note each", async () => {
    const user = await studio();
    const requestId = randomUUID();
    const a = deps();
    const b = deps();
    const [one, two] = await Promise.all([ask(user, requestId, a), ask(user, requestId, b)]);
    expect(one).toMatchObject({ ok: true, skipped: 0 });
    expect(two).toEqual(one);
    await Promise.all([...a.settled, ...b.settled]);
    expect((await reelsOf(user)).map((reel) => reel.id).sort()).toEqual([0, 1, 2].map((index) => createOptionIds(user.workspaceId, requestId, index).reelId).sort());
    expect(await notesOf(user)).toHaveLength(3);
    expect(await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId } })).toBe(3);
  });

  it("resumes a request the allowance stopped part-way: the started options are kept, the rest start, nothing is spent twice", async () => {
    const user = await studio();
    await leave(user, 2);
    const requestId = randomUUID();
    const first = deps();
    const partial = await ask(user, requestId, first);
    expect(partial).toMatchObject({ ok: true, skipped: 1 });
    if (!partial.ok) return;
    expect(partial.options).toHaveLength(2);
    // The third option's empty reel was not left behind.
    expect(await reelsOf(user)).toHaveLength(2);
    expect((await prisma.workflowRun.findFirstOrThrow({ where: { workspaceId: user.workspaceId, kind: "create" } })).status).toBe("RUNNING");

    // A request comes free (a top-up, a new month); the same request is sent again.
    const filler = await prisma.aiEdit.findFirstOrThrow({ where: { workspaceId: user.workspaceId, request: "earlier" } });
    await prisma.aiEdit.delete({ where: { id: filler.id } });
    const before = await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId } });
    const again = deps();
    const resumed = await ask(user, requestId, again);
    expect(resumed).toMatchObject({ ok: true, skipped: 0 });
    if (!resumed.ok) return;
    expect(resumed.options.slice(0, 2)).toEqual(partial.options);
    await Promise.all([...first.settled, ...again.settled]);
    // Exactly one more request was spent: the third option's.
    expect(await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId } })).toBe(before + 1);
    expect(await reelsOf(user)).toHaveLength(3);
    expect(await notesOf(user)).toHaveLength(3);
  });

  it("finishes a request that died between making an option's reel and starting its note, on the same reel", async () => {
    const user = await studio();
    const requestId = randomUUID();
    const dying = deps({ beforeNote: async () => { throw new Error("the instance stopped"); } });
    await expect(ask(user, requestId, dying, { options: 1 })).rejects.toThrow("the instance stopped");
    expect(await reelsOf(user)).toEqual([{ id: createOptionIds(user.workspaceId, requestId, 0).reelId }]);
    expect(await notesOf(user)).toHaveLength(0);
    const again = deps();
    const resumed = await ask(user, requestId, again, { options: 1 });
    expect(resumed).toMatchObject({ ok: true, skipped: 0, options: [{ reelId: createOptionIds(user.workspaceId, requestId, 0).reelId }] });
    await Promise.all(again.settled);
    expect(await reelsOf(user)).toHaveLength(1);
    expect(await notesOf(user)).toHaveLength(1);
  });

  it("refuses the same request id with a different payload, and makes and spends nothing for it", async () => {
    const user = await studio();
    const requestId = randomUUID();
    const first = deps();
    expect(await ask(user, requestId, first, { options: 1 })).toMatchObject({ ok: true });
    await Promise.all(first.settled);
    const other = deps();
    for (const change of [{ idea: "A day at our cafe, cosy and warm, from first coffee." }, { options: 2 }, { captions: false }, { voice: "aura-2:hyperion" }]) {
      expect(await ask(user, requestId, other, { options: 1, ...change })).toMatchObject({ ok: false, status: 409, reason: "request_mismatch" });
    }
    expect(other.calls).toBe(0);
    expect(await reelsOf(user)).toHaveLength(1);
    expect(await prisma.aiEdit.count({ where: { workspaceId: user.workspaceId } })).toBe(1);
  });

  it("keeps request ids apart between workspaces", async () => {
    const [one, two] = [await studio(), await studio()];
    const requestId = randomUUID();
    const a = deps();
    const b = deps();
    const [x, y] = [await ask(one, requestId, a, { options: 1 }), await ask(two, requestId, b, { options: 1 })];
    await Promise.all([...a.settled, ...b.settled]);
    expect(x.ok && y.ok && x.options[0].reelId !== y.options[0].reelId).toBe(true);
  });
});
