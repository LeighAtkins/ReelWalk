import { randomUUID } from "node:crypto";
import { AI_DRAFT_CREDITS, AI_PLAN_CREDITS, AI_QUEUE_LIMIT, AI_TRIAL_CREDITS, IN_FLIGHT_STATUSES, aiClipCredits, aiCreditWindow, aiFinalCredits, queueDecision, type AiClipSeconds } from "@reelwalk/core";
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
    create: { workspaceId, source: `trial:${workspaceId}`, kind: "TRIAL", amount: AI_TRIAL_CREDITS, remaining: AI_TRIAL_CREDITS }, update: {},
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
  referenceKey?: string; referenceType?: string; model: string; durationSeconds: AiClipSeconds; costCents: number; budgetCents: number;
  shot?: Prisma.InputJsonValue; frameSources?: Prisma.InputJsonValue;
  /** A spoken line: one credit more (ADR 0038). */
  voiced?: boolean;
  /** The presenter kit the composed stills use, and how many generated hops the face reference is from a real one (ADR 0056). */
  presenterId?: string; referenceDepth?: number;
  /** A draft (ADR 0076) costs one credit whatever its length; the voice is not made until the final. */
  tier?: "draft" | "final";
  /** The finished draft this take makes final: its credit is used toward the full price. A draft is made final once. */
  finalOf?: string;
}, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockBillingAccount(tx, input.workspaceId, now);
    const existing = await tx.aiGeneration.findUnique({
      where: { workspaceId_requestId: { workspaceId: input.workspaceId, requestId: input.requestId } },
    });
    if (existing) return existing;
    // A take queue, not a cap (ADR 0069): takes wait their turn; only the queue's length is bounded, since every
    // queued take holds its credits. The hour's limit on Veo submissions is kept by the worker when it starts a take.
    const inFlight = await tx.aiGeneration.count({ where: { workspaceId: input.workspaceId, status: { in: [...IN_FLIGHT_STATUSES] } } });
    if (inFlight >= AI_QUEUE_LIMIT) throw new AiCreditError(`The take queue is full (${AI_QUEUE_LIMIT} waiting or generating). Wait for one to finish.`);
    // Spend expiring monthly credits before lifetime trial/purchased credits.
    // An 8-second clip may draw on two grants, so plan the whole debit before taking any of it.
    let credits = input.tier === "draft" ? AI_DRAFT_CREDITS : aiClipCredits(input.durationSeconds, input.voiced);
    if (input.finalOf) {
      // Under the account lock, so two taps on "Make it final" cannot both use the draft's credit.
      const draft = await tx.aiGeneration.findFirst({ where: { id: input.finalOf, workspaceId: input.workspaceId, status: "SUCCEEDED" } });
      if ((draft?.shot as { tier?: string } | null)?.tier !== "draft") throw new AiCreditError("Make it final needs a finished draft from this workspace.");
      const taken = await tx.aiGeneration.count({ where: { workspaceId: input.workspaceId, status: { not: "FAILED" }, shot: { path: ["finalOf"], equals: draft!.id } } });
      if (taken) throw new AiCreditError("This draft has already been made final.");
      credits = aiFinalCredits(input.durationSeconds, Boolean(input.voiced), draft!.credits);
    }
    const grants = await tx.$queryRaw<{ id: string; remaining: number }[]>`
      SELECT "id", "remaining" FROM "AiCreditGrant" WHERE "workspaceId" = ${input.workspaceId}
      AND "remaining" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
      ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC FOR UPDATE`;
    const available = grants.reduce((sum, grant) => sum + grant.remaining, 0);
    if (!available) throw new AiCreditError("No AI credits left. Choose a plan or add more credits in Account.");
    if (available < credits) throw new AiCreditError(`${input.tier === "draft" ? "A draft" : input.voiced ? "A voiced" : "An"} ${input.durationSeconds}-second clip needs ${credits} ${credits === 1 ? "credit" : "credits"} and you have ${available}. Choose 4 seconds or add credits in Account.`);
    const debits: { grantId: string; credits: number }[] = [];
    for (const grant of grants) {
      const owed = credits - debits.reduce((sum, debit) => sum + debit.credits, 0);
      if (!owed) break;
      debits.push({ grantId: grant.id, credits: Math.min(owed, grant.remaining) });
    }
    // Prisma upsert is select-then-insert, so two first-ever reservations can race to create the row.
    await tx.$executeRaw`INSERT INTO "AiSpendBudget" ("id") VALUES ('vertex-video') ON CONFLICT ("id") DO NOTHING`;
    const reserved = await tx.aiSpendBudget.updateMany({
      where: { id: "vertex-video", reservedCents: { lte: input.budgetCents - input.costCents } },
      data: { reservedCents: { increment: input.costCents } },
    });
    if (reserved.count !== 1) throw new AiCreditError("AI generation is temporarily paused. Your credits have not been used.");
    for (const debit of debits) {
      await tx.aiCreditGrant.update({ where: { id: debit.grantId }, data: { remaining: { decrement: debit.credits } } });
    }
    return tx.aiGeneration.create({ data: {
      workspaceId: input.workspaceId, createdById: input.userId, requestId: input.requestId,
      prompt: input.prompt, referenceKey: input.referenceKey, referenceType: input.referenceType,
      shot: input.shot, frameSources: input.frameSources,
      model: input.model, grantId: debits[0].grantId, costCents: input.costCents,
      durationSeconds: input.durationSeconds, credits, grantDebits: debits.length > 1 ? debits : undefined,
      presenterId: input.presenterId, referenceDepth: input.referenceDepth,
    } });
  });
}

/** Refund once. Monthly refunds retain the original expiry, even across renewal. */
export async function failAiGeneration(db: PrismaClient, id: string, error: string, releaseBudget = false,
  /** Why, for queries (e.g. "identity_rejected"), and the identity gate's scores (ADR 0056). */
  details: { failureCode?: string; identityScore?: number; identityChecks?: Prisma.InputJsonValue;
    /** Refund only while the row still matches this, e.g. its lease token and "not yet submitted" (ADR 0056). */
    onlyIf?: Prisma.AiGenerationWhereInput } = {}) {
  const { onlyIf, ...recorded } = details;
  return db.$transaction(async (tx) => {
    const job = await tx.aiGeneration.findUniqueOrThrow({ where: { id } });
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${job.workspaceId} FOR UPDATE`;
    const changed = await tx.aiGeneration.updateMany({
      where: { id, status: { notIn: ["SUCCEEDED", "FAILED"] }, ...onlyIf },
      data: { status: "FAILED", error: error.slice(0, 400), finishedAt: new Date(), leaseUntil: null, leaseToken: null, ...recorded },
    });
    if (!changed.count) return;
    const debits = (job.grantDebits as { grantId: string; credits: number }[] | null) ?? [{ grantId: job.grantId, credits: job.credits }];
    for (const debit of debits) {
      await tx.aiCreditGrant.update({ where: { id: debit.grantId }, data: { remaining: { increment: debit.credits } } });
    }
    if (releaseBudget) await tx.aiSpendBudget.update({ where: { id: "vertex-video" }, data: { reservedCents: { decrement: job.costCents } } });
  });
}

/**
 * Durable leases let multiple workers resume polling without submitting twice.
 * A queued take starts only when its workspace's queue says so (ADR 0069):
 * oldest first, never while another of its takes is being composed, and never
 * past the hour's Veo submissions. Polling a running take is always allowed.
 */
export async function claimAiGeneration(db: PrismaClient, now = new Date()) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; workspaceId: string; status: string }[]>`
      SELECT "id", "workspaceId", "status" FROM "AiGeneration" WHERE "status" IN ('QUEUED', 'RUNNING')
      AND "nextPollAt" <= ${now} AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now})
      ORDER BY "createdAt" LIMIT 25 FOR UPDATE SKIP LOCKED`;
    const refused = new Set<string>();
    for (const row of rows) {
      if (row.status === "QUEUED") {
        if (refused.has(row.workspaceId)) continue;
        const queue = await tx.aiGeneration.findMany({
          where: { workspaceId: row.workspaceId, OR: [{ status: { in: ["QUEUED", "SUBMITTING"] } }, { submitStartedAt: { gt: new Date(now.getTime() - 3600_000) } }] },
          select: { id: true, status: true, createdAt: true, submitStartedAt: true, leaseUntil: true },
        });
        if (queueDecision(queue, now).nextId !== row.id) { refused.add(row.workspaceId); continue; }
      }
      return tx.aiGeneration.update({ where: { id: row.id }, data: {
        status: row.status === "QUEUED" ? "SUBMITTING" : "RUNNING",
        leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + 300_000),
      } });
    }
    return null;
  });
}
