import { randomUUID } from "node:crypto";
import { AI_PLAN_CREDITS, aiCreditWindow } from "@reelwalk/core";
import type { Prisma, PrismaClient } from "./generated/prisma/client";

type Tx = Prisma.TransactionClient;
const activeGrants = (workspaceId: string, now: Date) => ({
  workspaceId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

/** Every credit writer takes this lock before grants, including Stripe webhooks. */
export async function lockBillingAccount(tx: Tx, workspaceId: string, now = new Date()) {
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
  const account = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  await tx.aiCreditGrant.upsert({
    where: { source: `trial:${workspaceId}` },
    create: { workspaceId, source: `trial:${workspaceId}`, kind: "TRIAL", amount: 1, remaining: 1 }, update: {},
  });
  if (account.aiPaidPeriodStart && account.aiPaidThrough && account.aiPaidPlan !== "FREE") {
    const window = aiCreditWindow(account.aiPaidPeriodStart, account.aiPaidThrough, now);
    if (window) {
      const source = `monthly:${workspaceId}:${window.start.toISOString()}`;
      const amount = AI_PLAN_CREDITS[account.aiPaidPlan];
      const grant = await tx.aiCreditGrant.upsert({ where: { source }, update: {}, create: {
        workspaceId, source, kind: "MONTHLY", amount, remaining: amount, expiresAt: window.end,
      } });
      // An upgrade adds only the difference, so re-deliveries and plan changes
      // cannot restore credits already consumed this month.
      if (grant.amount < amount) await tx.aiCreditGrant.update({ where: { id: grant.id }, data: {
        amount, remaining: { increment: amount - grant.amount },
      } });
    }
  }
  return account;
}

export async function aiCreditSummary(db: PrismaClient, workspaceId: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    const account = await lockBillingAccount(tx, workspaceId, now);
    const grants = await tx.aiCreditGrant.findMany({ where: activeGrants(workspaceId, now) });
    return {
      plan: account.plan,
      paidThrough: account.aiPaidThrough?.toISOString() ?? null,
      resetsAt: account.aiPaidPeriodStart && account.aiPaidThrough ? aiCreditWindow(account.aiPaidPeriodStart, account.aiPaidThrough, now)?.end.toISOString() ?? null : null,
      hasCustomer: Boolean(account.stripeCustomerId),
      remaining: grants.reduce((sum, grant) => sum + grant.remaining, 0),
      monthly: grants.filter(g => g.kind === "MONTHLY").reduce((sum, g) => sum + g.remaining, 0),
      trial: grants.filter(g => g.kind === "TRIAL").reduce((sum, g) => sum + g.remaining, 0),
      topUp: grants.filter(g => g.kind === "TOP_UP").reduce((sum, g) => sum + g.remaining, 0),
    };
  });
}

export class AiCreditError extends Error {}

/** Account lock + conditional debit + budget reservation + job commit together. */
export async function reserveAiGeneration(db: PrismaClient, input: {
  workspaceId: string; userId: string; requestId: string; prompt: string;
  referenceKey?: string; referenceType?: string; model: string; costCents: number; budgetCents: number;
}, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockBillingAccount(tx, input.workspaceId, now);
    const existing = await tx.aiGeneration.findUnique({
      where: { workspaceId_requestId: { workspaceId: input.workspaceId, requestId: input.requestId } },
    });
    if (existing) return existing;
    const inFlight = await tx.aiGeneration.count({ where: { workspaceId: input.workspaceId, status: { in: ["QUEUED", "SUBMITTING", "RUNNING"] } } });
    if (inFlight >= 2) throw new AiCreditError("Two clips are already generating. Wait for one to finish.");
    const recent = await tx.aiGeneration.count({ where: { workspaceId: input.workspaceId, createdAt: { gt: new Date(now.getTime() - 3600_000) } } });
    if (recent >= 10) throw new AiCreditError("You've reached the hourly generation limit. Please try again later.");
    // Spend expiring monthly credits before lifetime trial/purchased credits.
    const [grant] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "AiCreditGrant" WHERE "workspaceId" = ${input.workspaceId}
      AND "remaining" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
      ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC LIMIT 1 FOR UPDATE`;
    if (!grant) throw new AiCreditError("No AI credits left. Choose a plan or add more credits in Account.");
    await tx.aiSpendBudget.upsert({ where: { id: "vertex-video" }, create: { id: "vertex-video" }, update: {} });
    const reserved = await tx.aiSpendBudget.updateMany({
      where: { id: "vertex-video", reservedCents: { lte: input.budgetCents - input.costCents } },
      data: { reservedCents: { increment: input.costCents } },
    });
    if (reserved.count !== 1) throw new AiCreditError("AI generation is temporarily paused. Your credits have not been used.");
    await tx.aiCreditGrant.update({ where: { id: grant.id }, data: { remaining: { decrement: 1 } } });
    return tx.aiGeneration.create({ data: {
      workspaceId: input.workspaceId, createdById: input.userId, requestId: input.requestId,
      prompt: input.prompt, referenceKey: input.referenceKey, referenceType: input.referenceType,
      model: input.model, grantId: grant.id, costCents: input.costCents,
    } });
  });
}

/** Refund once. Monthly refunds retain the original expiry, even across renewal. */
export async function failAiGeneration(db: PrismaClient, id: string, error: string, releaseBudget = false) {
  return db.$transaction(async (tx) => {
    const job = await tx.aiGeneration.findUniqueOrThrow({ where: { id } });
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${job.workspaceId} FOR UPDATE`;
    const changed = await tx.aiGeneration.updateMany({
      where: { id, status: { notIn: ["SUCCEEDED", "FAILED"] } },
      data: { status: "FAILED", error: error.slice(0, 400), finishedAt: new Date(), leaseUntil: null, leaseToken: null },
    });
    if (!changed.count) return;
    await tx.aiCreditGrant.update({ where: { id: job.grantId }, data: { remaining: { increment: 1 } } });
    if (releaseBudget) await tx.aiSpendBudget.update({ where: { id: "vertex-video" }, data: { reservedCents: { decrement: job.costCents } } });
  });
}

/** Durable leases let multiple workers resume polling without submitting twice. */
export async function claimAiGeneration(db: PrismaClient, now = new Date()) {
  return db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "AiGeneration" WHERE "status" IN ('QUEUED', 'RUNNING')
      AND "nextPollAt" <= ${now} AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now})
      ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!row) return null;
    const job = await tx.aiGeneration.findUniqueOrThrow({ where: { id: row.id } });
    return tx.aiGeneration.update({ where: { id: job.id }, data: {
      status: job.status === "QUEUED" ? "SUBMITTING" : "RUNNING",
      leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + 180_000),
    } });
  });
}
