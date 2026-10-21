import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@reelwalk/db";
import { createAiStepStore, type AiStepStore } from "../src/ai-jobs";

// The conditional writes of the Prisma AiStepStore against a migrated
// Postgres, like the outbox tests. Skipped without DATABASE_URL.
describe.skipIf(!process.env.DATABASE_URL)("AI step store (Postgres)", () => {
  let prisma: PrismaClient;
  let store: AiStepStore;
  let workspaceId: string;
  const old = () => new Date(Date.now() - 10 * 60_000);
  const message = (stepId: string) => ({ type: "ai-step" as const, stepId, generation: 1 });

  async function makeStep(kind = "director", over: { status?: "QUEUED" | "RUNNING"; heartbeatAt?: Date | null; submittedAt?: Date | null; cancelRequested?: boolean } = {}) {
    const requestId = crypto.randomUUID();
    const run = await prisma.workflowRun.create({ data: { workspaceId, userId: "u", reelId: "r", kind, requestId, requestHash: "h", cancelRequested: over.cancelRequested ?? false, status: kind === "director-run" ? "RUNNING" : "QUEUED" } });
    const step = await prisma.workflowStep.create({ data: {
      runId: run.id, index: 0, kind: "director-review", requestId, requestHash: "h", status: over.status ?? "QUEUED", heartbeatAt: over.heartbeatAt ?? null, submittedAt: over.submittedAt ?? null,
      payload: { request: "x", evidence: [{ assetId: "a", timesMs: [0], image: "data:image/jpeg;base64,AAAA" }] },
    } });
    return { runId: run.id, stepId: step.id };
  }

  beforeAll(async () => {
    ({ prisma } = await import("@reelwalk/db"));
    store = createAiStepStore(prisma);
    workspaceId = (await prisma.workspace.create({ data: { slug: `ai-steps-${Date.now()}`, name: "AI steps test" } })).id;
  });
  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("claims once, records the submission once, and publishes only under the lease", async () => {
    const { runId, stepId } = await makeStep();
    const claimed = await store.claim(message(stepId), old());
    expect(claimed).toMatchObject({ id: stepId, runId, attempt: 1, user: { id: "u", workspaceId } });
    expect(await store.claim(message(stepId), old())).toBeNull();
    const lease = { stepId, generation: 1, attempt: 1 };
    expect(await store.markSubmitted(lease)).toEqual({ ok: true });
    expect(await store.markSubmitted(lease)).toMatchObject({ ok: false });
    expect(await store.succeed({ ...lease, attempt: 2 }, { ok: true })).toBe(false);
    expect(await store.succeed(lease, { ok: true, editId: "e" })).toBe(true);
    const step = await prisma.workflowStep.findUniqueOrThrow({ where: { id: stepId } });
    expect(step.status).toBe("SUCCEEDED");
    expect(step.result).toEqual({ ok: true, editId: "e" });
    expect(step.payload).toEqual({ request: "x", evidence: [{ assetId: "a", timesMs: [0] }] });
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("SUCCEEDED");
  });

  it("reclaims a stale lease that was never submitted", async () => {
    const { stepId } = await makeStep("director", { status: "RUNNING", heartbeatAt: old() });
    expect(await store.claim(message(stepId), new Date(Date.now() - 60_000))).toMatchObject({ attempt: 1 });
  });

  it("never claims a submitted step; it can only be settled unresolved", async () => {
    const { runId, stepId } = await makeStep("director", { status: "RUNNING", heartbeatAt: old(), submittedAt: old() });
    expect(await store.claim(message(stepId), new Date(Date.now() - 60_000))).toBeNull();
    await store.settleAbandoned(message(stepId), "FAILED", "no", new Date(Date.now() - 60_000));
    expect((await prisma.workflowStep.findUniqueOrThrow({ where: { id: stepId } })).status).toBe("RUNNING");
    await store.settleAbandoned(message(stepId), "UNRESOLVED", "unknown", new Date(Date.now() - 60_000));
    expect((await prisma.workflowStep.findUniqueOrThrow({ where: { id: stepId } })).status).toBe("UNRESOLVED");
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("UNRESOLVED");
  });

  it("does not settle a step whose lease is fresh", async () => {
    const { stepId } = await makeStep("director", { status: "RUNNING", heartbeatAt: new Date(), submittedAt: new Date() });
    await store.settleAbandoned(message(stepId), "UNRESOLVED", "unknown", new Date(Date.now() - 60_000));
    expect((await prisma.workflowStep.findUniqueOrThrow({ where: { id: stepId } })).status).toBe("RUNNING");
  });

  it("requeues only an unsubmitted step", async () => {
    const { stepId } = await makeStep();
    await store.claim(message(stepId), old());
    const lease = { stepId, generation: 1, attempt: 1 };
    await store.requeue(lease, "blip");
    expect((await prisma.workflowStep.findUniqueOrThrow({ where: { id: stepId } })).status).toBe("QUEUED");
    await store.claim(message(stepId), old());
    const second = { ...lease, attempt: 2 };
    await store.markSubmitted(second);
    await store.requeue(second, "blip");
    expect((await prisma.workflowStep.findUniqueOrThrow({ where: { id: stepId } })).status).toBe("RUNNING");
  });

  it("re-enqueues an old queued step with an empty outbox instead of failing it", async () => {
    const queued = await makeStep("director");
    await prisma.$executeRaw`UPDATE "WorkflowStep" SET "updatedAt" = now() - interval '45 minutes', "createdAt" = now() - interval '45 minutes' WHERE id = ${queued.stepId}`;
    const counts = await store.reapAbandoned(new Date(), { maxAgeMs: 30 * 60_000 });
    expect(counts.requeued).toBeGreaterThanOrEqual(1);
    const step = await prisma.workflowStep.findUniqueOrThrow({ where: { id: queued.stepId } });
    expect(step.status).toBe("QUEUED");
    expect(Date.now() - step.updatedAt.getTime()).toBeLessThan(60_000);
    const messages = await prisma.outboxMessage.findMany({ where: { body: { contains: queued.stepId } } });
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].body)).toEqual({ type: "ai-step", stepId: queued.stepId, generation: 1 });
    await prisma.outboxMessage.deleteMany({ where: { body: { contains: queued.stepId } } });
  });

  it("fails a queued step only past the queue's retention, and settles silent running steps", async () => {
    const expired = await makeStep("director");
    const sent = await makeStep("director", { status: "RUNNING", heartbeatAt: old(), submittedAt: old() });
    const pending = await makeStep("director");
    await prisma.outboxMessage.create({ data: { topic: "test-reaper", body: JSON.stringify({ type: "ai-step", stepId: pending.stepId, generation: 1 }) } });
    await prisma.$executeRaw`UPDATE "WorkflowStep" SET "updatedAt" = now() - interval '5 days', "createdAt" = now() - interval '5 days' WHERE id IN (${expired.stepId}, ${pending.stepId})`;
    await prisma.$executeRaw`UPDATE "WorkflowStep" SET "updatedAt" = now() - interval '45 minutes', "heartbeatAt" = now() - interval '45 minutes' WHERE id = ${sent.stepId}`;
    await store.reapAbandoned(new Date(), { maxAgeMs: 30 * 60_000, retentionMs: 4 * 24 * 60 * 60_000 });
    const status = async (id: string) => (await prisma.workflowStep.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(expired.stepId)).toBe("FAILED");
    expect(await status(sent.stepId)).toBe("UNRESOLVED");
    expect(await status(pending.stepId)).toBe("QUEUED");
    await prisma.outboxMessage.deleteMany({ where: { topic: "test-reaper" } });
  });

  it("honours a persisted stop: no claim, no submission", async () => {
    const stopped = await makeStep("director", { cancelRequested: true });
    expect(await store.claim(message(stopped.stepId), old())).toBeNull();
    const { runId, stepId } = await makeStep("director-run");
    await store.claim(message(stepId), old());
    await prisma.workflowRun.update({ where: { id: runId }, data: { cancelRequested: true } });
    expect(await store.markSubmitted({ stepId, generation: 1, attempt: 1 })).toEqual({ ok: false, cancelled: true });
    await store.fail({ stepId, generation: 1, attempt: 1 }, "Stopped.");
    // A stopped Director run closes when its last step settles.
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("FAILED");
  });
});
