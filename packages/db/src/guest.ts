import { randomUUID } from "node:crypto";
import { trialEndsAt, TRIAL_PLAN } from "@reelwalk/core";
import type { PrismaClient } from "./generated/prisma/client";

/** Guest creation and its IP allowance commit together, including parallel requests. */
export async function createGuestWorkspace(client: PrismaClient, key: string, now = new Date()) {
  return client.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ count: number }[]>`
      INSERT INTO "AuthThrottle" ("key", "count", "windowStart") VALUES (${key}, 1, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "AuthThrottle"."windowStart" <= ${new Date(now.getTime() - 86400000)} THEN 1 ELSE "AuthThrottle"."count" + 1 END,
        "windowStart" = CASE WHEN "AuthThrottle"."windowStart" <= ${new Date(now.getTime() - 86400000)} THEN ${now} ELSE "AuthThrottle"."windowStart" END
      RETURNING "count"`;
    if (rows[0].count > 3) throw new Error("This network has started three free studios today. Sign in to continue, or try tomorrow.");
    const token = randomUUID();
    const workspace = await tx.workspace.create({ data: { slug: `guest-${token}`, name: "Your listing studio" } });
    return tx.user.create({ data: { workspaceId: workspace.id, email: `${token}@guest.reelwalk.local`, name: "Guest", isGuest: true } });
  }, { maxWait: 15000, timeout: 20000 });
}

/** Claim in place: uploads, reels and credit history retain their ownership. */
export async function claimGuestWorkspace(client: PrismaClient, userId: string, input: { email: string; passwordHash: string; name: string }, now = new Date()) {
  return client.$transaction(async tx => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.isGuest) throw new Error("This studio has already been saved. Sign in to continue.");
    const changed = await tx.user.updateMany({ where: { id: user.id, isGuest: true }, data: { ...input, isGuest: false } });
    if (changed.count !== 1) throw new Error("This studio has already been saved.");
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.workspace.update({ where: { id: user.workspaceId }, data: { trialStartedAt: now, compedPlan: TRIAL_PLAN, compedUntil: trialEndsAt(now) } });
    return user.id;
  }, { maxWait: 15000, timeout: 20000 });
}
