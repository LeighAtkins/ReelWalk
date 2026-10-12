import { createHash } from "node:crypto";
import { prisma } from "@reelwalk/db";

/** Password reset links (apps/web/app/password-reset-actions.ts): the table stores only the token's SHA-256. */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The reset row behind a link with its user, or null when the link is unknown, used or past its hour. */
export async function openPasswordReset(token: string) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const reset = await prisma.passwordReset.findUnique({
    where: { tokenHash: hashResetToken(token) },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!reset || reset.usedAt || reset.expiresAt.getTime() < Date.now()) return null;
  return reset;
}
