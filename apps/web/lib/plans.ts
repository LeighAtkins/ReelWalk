import { prisma } from "@reelwalk/db";
import { effectivePlan, monthStart, PLANS, type PlanDef, type PlanId } from "@reelwalk/core";

export type WorkspacePlan = {
  id: PlanId;
  plan: PlanDef;
  /** True when the plan comes from a hand-given period rather than a subscription. */
  comped: boolean;
  compedUntil: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  planRenewsAt: Date | null;
};

/** The plan a workspace is on right now, and where it comes from. */
export async function workspacePlan(workspaceId: string, now: Date = new Date()): Promise<WorkspacePlan> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { plan: true, compedPlan: true, compedUntil: true, stripeCustomerId: true, stripeSubscriptionId: true, planRenewsAt: true },
  });
  const id = effectivePlan(workspace, now);
  return {
    id,
    plan: PLANS[id],
    comped: workspace.plan === "FREE" && id !== "FREE",
    compedUntil: workspace.compedUntil,
    stripeCustomerId: workspace.stripeCustomerId,
    stripeSubscriptionId: workspace.stripeSubscriptionId,
    planRenewsAt: workspace.planRenewsAt,
  };
}

/** Exports started this calendar month that did not fail (failed ones are not charged against the allowance). */
export function exportsThisMonth(workspaceId: string, now: Date = new Date()): Promise<number> {
  return prisma.renderJob.count({
    // Story cuts (ADR 0065) are made from an export already counted.
    where: { workspaceId, kind: { notIn: ["PREVIEW", "STORY"] }, status: { not: "FAILED" }, createdAt: { gte: monthStart(now) } },
  });
}

/** Bytes of the workspace's own uploads. */
export async function storageUsed(workspaceId: string): Promise<number> {
  const { _sum } = await prisma.mediaAsset.aggregate({ where: { workspaceId }, _sum: { sizeBytes: true } });
  return Number(_sum.sizeBytes ?? 0n);
}
