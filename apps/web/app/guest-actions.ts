"use server";
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { claimGuestWorkspace, createGuestWorkspace, hashPassword, prisma } from "@reelwalk/db";
import { emptyTimeline } from "@reelwalk/core";
import { createSession, getSessionUser } from "@/lib/auth";
import { clientIp, countAttempt, overLimit, MINUTE } from "@/lib/throttle";

export async function startGuestTrial(): Promise<void> {
  const existing = await getSessionUser();
  if (existing) redirect("/");
  const key = `guest:ip:${createHash("sha256").update(await clientIp()).digest("hex")}`;
  let id: string;
  try {
    const user = await createGuestWorkspace(prisma, key);
    await createSession(user.id, 7);
    const reel = await prisma.reel.create({ data: { workspaceId: user.workspaceId, title: "My first listing", timeline: emptyTimeline() } });
    id = reel.id;
  } catch (error) {
    redirect(error instanceof Error && error.message.startsWith("This network") ? "/try?error=limit" : "/try?error=unavailable");
  }
  redirect(`/reels/${id}?auto=1`);
}

export async function claimGuest(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user?.isGuest) redirect("/");
  const reelId = z.string().min(1).max(64).safeParse(formData.get("reelId"));
  const next = reelId.success && await prisma.reel.count({ where: { id: reelId.data, workspaceId: user.workspaceId } }) ? `/reels/${reelId.data}?export=1` : "/";
  const back = `/signup?next=${encodeURIComponent(next)}`;
  const parsed = z.object({ email: z.string().trim().toLowerCase().email().max(200).refine(v => !v.endsWith("@guest.reelwalk.local")), password: z.string().min(8).max(200) }).safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect(`${back}&error=${encodeURIComponent("Enter your email and a password of at least 8 characters.")}`);
  const limits = [{ key: `claim:${user.id}`, max: 10, windowMs: 15 * MINUTE }];
  if (await overLimit(limits)) redirect(`${back}&error=Please%20try%20again%20in%2015%20minutes.`);
  await countAttempt(limits);
  try {
    await claimGuestWorkspace(prisma, user.id, { email: parsed.data.email, passwordHash: await hashPassword(parsed.data.password), name: parsed.data.email.split("@")[0].slice(0,80) });
  } catch {
    redirect(`${back}&error=${encodeURIComponent("Could not save this account. If that email is registered, sign in instead. Your draft is still here.")}`);
  }
  await createSession(user.id);
  redirect(next);
}
