import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { aiCreditSummary, claimAiGeneration, failAiGeneration, prisma, reserveAiGeneration } from "../src";

describe.skipIf(!process.env.DATABASE_URL)("AI credits (Postgres)", () => {
  const prefix = `ai-test-${randomUUID()}`;
  const workspaceIds: string[] = [];
  async function studio() {
    const workspace = await prisma.workspace.create({ data: {
      slug: `${prefix}-${randomUUID()}`, name: "AI test", users: { create: { email: `${randomUUID()}@example.test`, name: "Test" } },
    }, include: { users: true } });
    workspaceIds.push(workspace.id);
    return { workspaceId: workspace.id, userId: workspace.users[0]!.id, model: "test-model", prompt: "A quiet room in daylight", costCents: 80, budgetCents: 1_000_000 };
  }
  afterAll(async () => {
    await prisma.aiGeneration.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    // Submissions never reach Google in these tests; unwind their reservations.
    const jobs = await prisma.aiSpendBudget.findUnique({ where: { id: "vertex-video" } });
    if (jobs) await prisma.aiSpendBudget.update({ where: { id: jobs.id }, data: { reservedCents: { decrement: charged } } });
    await prisma.$disconnect();
  });
  let charged = 0;

  it("allows only one simultaneous use of the lifetime trial", async () => {
    const input = await studio();
    const results = await Promise.allSettled([1, 2, 3].map(() => reserveAiGeneration(prisma, { ...input, requestId: randomUUID() })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    charged += 80;
    expect((await aiCreditSummary(prisma, input.workspaceId)).remaining).toBe(0);
  });

  it("deduplicates a request and refunds a failure exactly once", async () => {
    const input = { ...await studio(), requestId: randomUUID() };
    const first = await reserveAiGeneration(prisma, input); charged += 80;
    const again = await reserveAiGeneration(prisma, input);
    expect(again.id).toBe(first.id);
    await Promise.all([failAiGeneration(prisma, first.id, "failed"), failAiGeneration(prisma, first.id, "failed")]);
    expect((await aiCreditSummary(prisma, input.workspaceId)).remaining).toBe(1);
  });

  it("rolls back the debit when the shared spending ceiling is reached", async () => {
    const input = await studio();
    const budget = await prisma.aiSpendBudget.findUniqueOrThrow({ where: { id: "vertex-video" } });
    await expect(reserveAiGeneration(prisma, { ...input, requestId: randomUUID(), budgetCents: budget.reservedCents })).rejects.toThrow("temporarily paused");
    expect((await aiCreditSummary(prisma, input.workspaceId)).remaining).toBe(1);
    expect(await prisma.aiGeneration.count({ where: { workspaceId: input.workspaceId } })).toBe(0);
  });

  it("resets annual subscribers monthly without restoring spent credits", async () => {
    const input = await studio();
    await prisma.workspace.update({ where: { id: input.workspaceId }, data: {
      aiPaidPlan: "AGENT", aiPaidPeriodStart: new Date("2026-01-31T00:00:00Z"), aiPaidThrough: new Date("2027-01-31T00:00:00Z"),
    } });
    const february = new Date("2026-02-28T12:00:00Z");
    expect((await aiCreditSummary(prisma, input.workspaceId, february)).monthly).toBe(10);
    const job = await reserveAiGeneration(prisma, { ...input, requestId: randomUUID() }, february); charged += 80;
    expect((await aiCreditSummary(prisma, input.workspaceId, february)).monthly).toBe(9);
    const march = new Date("2026-03-31T12:00:00Z");
    expect((await aiCreditSummary(prisma, input.workspaceId, march)).monthly).toBe(10);
    await failAiGeneration(prisma, job.id, "late failure");
    // The February refund cannot add to the new month's allowance.
    expect((await aiCreditSummary(prisma, input.workspaceId, march)).monthly).toBe(10);
  });

  it("leases a queued job once across concurrent workers", async () => {
    const input = await studio();
    const job = await reserveAiGeneration(prisma, { ...input, requestId: randomUUID() }); charged += 80;
    // Other tests' queued jobs are excluded by moving this one before them.
    await prisma.aiGeneration.update({ where: { id: job.id }, data: { createdAt: new Date("2000-01-01") } });
    const claims = await Promise.all([claimAiGeneration(prisma), claimAiGeneration(prisma)]);
    expect(claims.filter(c => c?.id === job.id)).toHaveLength(1);
    expect((await prisma.aiGeneration.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUBMITTING");
  });
});
