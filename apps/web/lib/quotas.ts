import { nextPlan, PLANS } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { exportsThisMonth, storageUsed, workspacePlan } from "@/lib/plans";

/**
 * Per-workspace limits, set by the plan (plans in @reelwalk/core): exports a
 * month, exports in any 24 hours, exports at once. A studio with an admin in
 * it (ReelWalk's own, isAdmin set by hand) has no monthly or daily cap; the
 * at-once limit still holds, because it protects the render queue.
 */

/** A limit that was hit: what to tell the studio, and whether a bigger plan would lift it. */
export type Limit = { message: string; upgrade: boolean };

export async function isUnlimited(workspaceId: string): Promise<boolean> {
  // An admin whose home it is, or who holds a seat in it (ADR 0079).
  return (await prisma.user.count({ where: { isAdmin: true, OR: [{ workspaceId }, { memberships: { some: { workspaceId } } }] } })) > 0;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;

/** Why another export cannot start now, or null if it can. */
export async function exportBlockedReason(workspaceId: string): Promise<Limit | null> {
  const [{ plan, id }, active, lastDay, thisMonth, unlimited] = await Promise.all([
    workspacePlan(workspaceId),
    prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, status: { in: ["QUEUED", "RUNNING"] } } }),
    prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    exportsThisMonth(workspaceId),
    isUnlimited(workspaceId),
  ]);
  const next = nextPlan(id);
  if (active >= plan.activeExports) {
    return {
      message: `${active} exports are already rendering. Start this one when one of them has finished; they keep going if you leave.${next ? ` ${next.name} renders ${next.activeExports} at once.` : ""}`,
      upgrade: next !== null,
    };
  }
  if (unlimited) return null;
  if (thisMonth >= plan.exportsPerMonth) {
    return id === "FREE"
      ? { message: `That is all ${plan.exportsPerMonth} of this month's free exports. The ${PLANS.AGENT.name} plan has ${PLANS.AGENT.exportsPerMonth} a month, at full size and without the mark.`, upgrade: true }
      : { message: `That makes ${plan.exportsPerMonth} exports this month, the ${plan.name} plan's allowance. It resets on the 1st${next ? `; ${next.name} has ${next.exportsPerMonth} a month` : ""}.`, upgrade: next !== null };
  }
  if (lastDay >= plan.exportsPerDay) {
    return {
      message: `That makes ${plan.exportsPerDay} exports in 24 hours, the ${plan.name} plan's daily limit. Exports open up again over the next day${next ? `, or ${next.name} allows ${next.exportsPerDay} a day` : ""}.`,
      upgrade: next !== null,
    };
  }
  return null;
}

/** Why a retry cannot start now, or null if it can. Retries only count against the exports running at once. */
export async function retryBlockedReason(workspaceId: string): Promise<string | null> {
  const [{ plan }, active] = await Promise.all([
    workspacePlan(workspaceId),
    prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, status: { in: ["QUEUED", "RUNNING"] } } }),
  ]);
  return active >= plan.activeExports ? `${active} exports are already rendering. Retry when one has finished.` : null;
}

/** Why `adding` more bytes would not fit in the workspace's library, or null if they would. */
export async function storageBlockedReason(workspaceId: string, adding: number, fileName: string): Promise<string | null> {
  const [{ plan, id }, used] = await Promise.all([workspacePlan(workspaceId), storageUsed(workspaceId)]);
  const limit = plan.storageGb * 1024 ** 3;
  if (used + adding <= limit) return null;
  const more = id === "FREE" ? ` The ${PLANS.AGENT.name} plan has ${PLANS.AGENT.storageGb} GB.` : "";
  return `${fileName} does not fit: your library holds ${gb(used)} of its ${gb(limit)}.${more}`;
}
