import { beforeEach, describe, expect, it, vi } from "vitest";

// Walk the block's web side (ADR 0093): the switch, and restarting a solve that cannot finish. The database, the queue
// and the worker launcher are faked; what matters is what is written.
const db = vi.hoisted(() => ({
  run: null as null | { id: string; requestHash: string; cancelRequested: boolean; steps: { id: string; status: string }[] },
  writes: [] as { model: string; op: string; args: unknown }[],
  queued: [] as string[],
}));

vi.mock("@reelwalk/db", () => {
  const tx = {
    workflowStep: {
      updateMany: async (args: { where: { status: string } }) => {
        db.writes.push({ model: "step", op: "updateMany", args });
        const step = db.run?.steps[0];
        if (!step || step.status !== args.where.status) return { count: 0 };
        step.status = "QUEUED";
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ id: db.run!.steps[0].id, generation: 2 }),
      create: async () => ({ id: "new-step", generation: 1 }),
    },
    workflowRun: {
      update: async (args: { data: { cancelRequested?: boolean } }) => {
        db.writes.push({ model: "run", op: "update", args });
        if (args.data.cancelRequested === false) db.run!.cancelRequested = false;
        return {};
      },
      create: async () => ({ id: "new-run" }),
    },
  };
  return {
    RENDER_JOBS_TOPIC: "render-jobs",
    addToOutbox: async (_tx: unknown, _topic: string, body: string) => void db.queued.push(body),
    prisma: {
      workflowRun: { findUnique: async () => db.run },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock("./render-capacity", () => ({ ensureWorkerRunning: async () => undefined }));
vi.mock("./render-jobs", () => ({ flushOutbox: async () => undefined }));
vi.mock("./storage", () => ({ mediaUrl: async () => "", readObject: async () => null }));

import { walkBlockEnabled } from "./walk-block";
import { requestHash, startWorkerStepRun } from "./workflows";

const user = { id: "u1", workspaceId: "w1" };
const payload = { assetId: "clip1" };
const start = () => startWorkerStepRun({ user, kind: "block-solve", requestId: "block-solve:clip1:v1", payload });

beforeEach(() => {
  db.writes = [];
  db.queued = [];
});

describe("walkBlockEnabled", () => {
  it("is on without AI_JOBS_DURABLE (worker-only steps need only the render queue), off when switched off", () => {
    expect(walkBlockEnabled({})).toBe(true);
    expect(walkBlockEnabled({ AI_JOBS_DURABLE: "0" })).toBe(true);
    expect(walkBlockEnabled({ WALK_BLOCK: "off" })).toBe(false);
  });
});

describe("startWorkerStepRun", () => {
  it("restarts a stopped solve: clears the stop flag with the re-queue, so the worker's claim is not refused again", async () => {
    db.run = { id: "r1", requestHash: requestHash(payload), cancelRequested: true, steps: [{ id: "s1", status: "FAILED" }] };
    const started = await start();
    expect(started).toMatchObject({ ok: true, jobId: "s1", resumed: true });
    const runWrite = db.writes.find((w) => w.model === "run");
    expect(runWrite?.args).toMatchObject({ where: { id: "r1" }, data: { status: "QUEUED", cancelRequested: false } });
    expect(db.run.cancelRequested).toBe(false);
    expect(db.queued).toHaveLength(1);
  });

  it("restarts a stopped solve that never started (QUEUED behind the stop flag)", async () => {
    db.run = { id: "r1", requestHash: requestHash(payload), cancelRequested: true, steps: [{ id: "s1", status: "QUEUED" }] };
    await start();
    expect(db.run.cancelRequested).toBe(false);
    expect(db.queued).toHaveLength(1);
  });

  it("restarts a failed solve and resumes one that is running or done", async () => {
    db.run = { id: "r1", requestHash: requestHash(payload), cancelRequested: false, steps: [{ id: "s1", status: "FAILED" }] };
    await start();
    expect(db.queued).toHaveLength(1);
    for (const status of ["RUNNING", "SUCCEEDED", "QUEUED"]) {
      db.queued = [];
      db.run = { id: "r1", requestHash: requestHash(payload), cancelRequested: false, steps: [{ id: "s1", status }] };
      expect(await start()).toMatchObject({ ok: true, jobId: "s1", resumed: true });
      expect(db.queued).toHaveLength(0);
    }
  });

  it("refuses the same request id for a different request", async () => {
    db.run = { id: "r1", requestHash: "other", cancelRequested: true, steps: [{ id: "s1", status: "FAILED" }] };
    expect(await start()).toMatchObject({ ok: false, status: 409 });
    expect(db.queued).toHaveLength(0);
  });
});
