"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { hashPassword, prisma } from "@reelwalk/db";
import { appUrl } from "@/lib/app-url";
import { createSession } from "@/lib/auth";
import { emailHtml, sendEmail } from "@/lib/email";
import { hashResetToken, openPasswordReset } from "@/lib/password-reset";
import { clientIp, countAttempt, MINUTE, overLimit, type Limit } from "@/lib/throttle";

/**
 * "Forgot your password?" (ADR 0016). The email carries a random token; the
 * table keeps its SHA-256, an expiry an hour out, and the moment it was used.
 * The forgot form answers the same whether or not the address has an account,
 * and in the same time: the lookup, the write and the send all run after the
 * response, so a known address costs the caller nothing extra.
 */

const RESET_MINUTES = 60;

const emailSchema = z.string().trim().toLowerCase().email().max(200);

export async function requestPasswordReset(formData: FormData): Promise<void> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) redirect("/forgot?error=email");
  const email = parsed.data;

  // Three links an hour for one address, twenty from one network. The
  // counters run whether or not the address has an account, so the answer
  // does not change with it.
  const limits: Limit[] = [
    { key: `forgot:email:${email}`, max: 3, windowMs: 60 * MINUTE },
    { key: `forgot:ip:${await clientIp()}`, max: 20, windowMs: 60 * MINUTE },
  ];
  if (await overLimit(limits)) redirect("/forgot?error=throttled");
  await countAttempt(limits);
  // Throws when EMAIL_FROM is set without APP_URL; better here than in a link nobody can trust.
  const base = await appUrl();

  // Everything that depends on whether the account exists happens after the
  // redirect has gone out, so timing says nothing either.
  after(async () => {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, passwordHash: true } });
    if (!user || !user.passwordHash) return;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + RESET_MINUTES * MINUTE);
    await prisma.$transaction([
      // A new link replaces any older one still open.
      prisma.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } }),
      prisma.passwordReset.create({ data: { userId: user.id, tokenHash: hashResetToken(token), expiresAt } }),
    ]);
    const url = `${base}/reset/${token}`;
    try {
      await sendEmail({
        to: email,
        subject: "Reset your ReelWalk password",
        text: [
          `Hi ${user.name},`,
          "",
          "Someone asked to reset the password for your ReelWalk studio. If it was you, open this link within the hour and choose a new one:",
          url,
          "",
          "If it was not you, ignore this email; your password stays as it is.",
        ].join("\n"),
        html: emailHtml({
          heading: "Reset your password",
          paragraphs: [
            `Hi ${user.name},`,
            "Someone asked to reset the password for your ReelWalk studio. If it was you, choose a new one within the hour.",
            "If it was not you, ignore this email; your password stays as it is.",
          ],
          button: { label: "Choose a new password", url },
        }),
      });
    } catch (error) {
      console.error(`password reset: email to ${email} failed`, error);
    }
  });

  // Old rows are dead weight; clear them now and then.
  if (Math.random() < 0.05) {
    after(() => prisma.passwordReset.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * MINUTE) } } }));
  }
  redirect("/forgot?sent=1");
}

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

export async function resetPassword(formData: FormData): Promise<void> {
  const parsed = resetSchema.safeParse({ token: formData.get("token"), password: formData.get("password") });
  if (!parsed.success) redirect("/forgot?error=expired");
  const reset = await openPasswordReset(parsed.data.token);
  if (!reset) redirect("/forgot?error=expired");

  const passwordHash = await hashPassword(parsed.data.password);
  const used = await prisma.$transaction(async (tx) => {
    // Two tabs cannot both spend the same link, and a link that ran out while the form was open is refused.
    const { count } = await tx.passwordReset.updateMany({
      where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count === 0) return false;
    await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
    // Whoever held the old password is signed out everywhere.
    await tx.session.deleteMany({ where: { userId: reset.userId } });
    return true;
  });
  if (!used) redirect("/forgot?error=expired");

  await createSession(reset.userId);
  redirect("/account?saved=password");
}
