import { prisma } from "@reelwalk/db";

/**
 * Per-workspace limits. They keep one account from holding every render
 * worker, running up the bill, or filling the bucket; none of them should
 * matter to someone using ReelWalk normally.
 */
export const QUOTAS = {
  /** Exports queued or rendering at once. */
  activeExports: Number(process.env.QUOTA_ACTIVE_EXPORTS ?? 3),
  /** Exports started in any 24 hours. */
  exportsPerDay: Number(process.env.QUOTA_EXPORTS_PER_DAY ?? 30),
  /** Uploaded media kept per workspace. */
  storageBytes: Number(process.env.QUOTA_STORAGE_GB ?? 25) * 1024 ** 3,
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;

/** Why another export cannot start now, or null if it can. */
export async function exportBlockedReason(workspaceId: string): Promise<string | null> {
  const [active, lastDay] = await Promise.all([
    prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, status: { in: ["QUEUED", "RUNNING"] } } }),
    prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
  ]);
  if (active >= QUOTAS.activeExports) {
    return `${active} exports are already rendering. Start this one when one of them has finished; they keep going if you leave.`;
  }
  if (lastDay >= QUOTAS.exportsPerDay) {
    return `That makes ${QUOTAS.exportsPerDay} exports in 24 hours, the daily limit. Exports open up again over the next day.`;
  }
  return null;
}

/** Why a retry cannot start now, or null if it can. Retries only count against the exports running at once. */
export async function retryBlockedReason(workspaceId: string): Promise<string | null> {
  const active = await prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, status: { in: ["QUEUED", "RUNNING"] } } });
  return active >= QUOTAS.activeExports ? `${active} exports are already rendering. Retry when one has finished.` : null;
}

/** Why `adding` more bytes would not fit in the workspace's library, or null if they would. */
export async function storageBlockedReason(workspaceId: string, adding: number, fileName: string): Promise<string | null> {
  const { _sum } = await prisma.mediaAsset.aggregate({ where: { workspaceId }, _sum: { sizeBytes: true } });
  const used = Number(_sum.sizeBytes ?? 0n);
  if (used + adding <= QUOTAS.storageBytes) return null;
  return `${fileName} does not fit: your library holds ${gb(used)} of its ${gb(QUOTAS.storageBytes)}.`;
}
