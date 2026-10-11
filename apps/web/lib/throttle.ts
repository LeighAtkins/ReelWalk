import { headers } from "next/headers";
import { prisma } from "@reelwalk/db";

/**
 * Fixed-window counters in Postgres, shared by every web instance: sign-in
 * attempts per email and per address, sign-ups per address, password checks
 * per user. They slow password guessing and sign-up spam to a crawl without
 * a separate store.
 */
export type Limit = { key: string; max: number; windowMs: number };

export const MINUTE = 60_000;

/** The caller's address, as App Runner's proxy reports it. */
export async function clientIp(): Promise<string> {
  const forwarded = (await headers()).get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

/** True when any of the limits is used up inside its current window. */
export async function overLimit(limits: Limit[]): Promise<boolean> {
  const rows = await prisma.authThrottle.findMany({ where: { key: { in: limits.map((limit) => limit.key) } } });
  const now = Date.now();
  return limits.some((limit) => {
    const row = rows.find((candidate) => candidate.key === limit.key);
    return row !== undefined && now - row.windowStart.getTime() < limit.windowMs && row.count >= limit.max;
  });
}

/** Counts one attempt against each limit; a window that has passed starts again from one. */
export async function countAttempt(limits: Limit[]): Promise<void> {
  const now = new Date();
  await Promise.all(
    limits.map(async (limit) => {
      await prisma.authThrottle.updateMany({
        where: { key: limit.key, windowStart: { lt: new Date(now.getTime() - limit.windowMs) } },
        data: { count: 0, windowStart: now },
      });
      await prisma.authThrottle.upsert({
        where: { key: limit.key },
        create: { key: limit.key, count: 1, windowStart: now },
        update: { count: { increment: 1 } },
      });
    }),
  );
  // Rows from long-finished windows are dead weight; clear them now and then.
  if (Math.random() < 0.02) {
    await prisma.authThrottle.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - 24 * 60 * MINUTE) } } });
  }
}

export async function clearAttempts(keys: string[]): Promise<void> {
  await prisma.authThrottle.deleteMany({ where: { key: { in: keys } } });
}
