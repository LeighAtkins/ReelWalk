import { prisma } from "@reelwalk/db";
import { exportsThisMonth, storageUsed, workspacePlan } from "@/lib/plans";

/**
 * Per-workspace limits. The plan sets them (plans in @reelwalk/core); a
 * daily cap on top keeps one account from running up the render bill in an
 * afternoon, whatever its plan.
 */
export const EXPORTS_PER_DAY = Number(process.env.QUOTA_EXPORTS_PER_DAY ?? 30);

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;

/** Why another export cannot start now, or null if it can. */
export async function exportBlockedReason(workspaceId: string): Promise<string | null> {
  const [{ plan, id }, active, lastDay, thisMonth] = await Promise.all([
    workspacePlan(workspaceId),
    prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, status: { in: ["QUEUED", "RUNNING"] } } }),
    prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    exportsThisMonth(workspaceId),
  ]);
  if (active >= plan.activeExports) {
    return `${active} exports are already rendering. Start this one when one of them has finished; they keep going if you leave.`;
  }
  if (thisMonth >= plan.exportsPerMonth) {
    return id === "FREE"
      ? `That is all ${plan.exportsPerMonth} of this month's free exports. The Agent plan has 50 a month, at full size and without the mark.`
      : `That makes ${plan.exportsPerMonth} exports this month, the ${plan.name} plan's allowance. It resets on the 1st.`;
  }
  if (lastDay >= EXPORTS_PER_DAY) {
    return `That makes ${EXPORTS_PER_DAY} exports in 24 hours, the daily limit. Exports open up again over the next day.`;
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
  const more = id === "FREE" ? " The Agent plan has 25 GB." : "";
  return `${fileName} does not fit: your library holds ${gb(used)} of its ${gb(limit)}.${more}`;
}
