"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DEFAULT_USER_EMAIL, hashPassword, prisma, verifyPassword } from "@reelwalk/db";
import { createSession, destroySession } from "@/lib/auth";
import { clearAttempts, clientIp, countAttempt, MINUTE, overLimit, type Limit } from "@/lib/throttle";
import { getCurrentUser } from "@/lib/workspace";

/** Only same-site paths may be used as the "next" target after sign-in. */
function safeNext(value: unknown): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export async function signIn(formData: FormData): Promise<void> {
  const next = safeNext(formData.get("next"));
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  const back = `/login?error=credentials&next=${encodeURIComponent(next)}`;
  if (!parsed.success) redirect(back);

  // Ten wrong passwords for one email, or fifty from one address, in fifteen
  // minutes, and that email or address waits out the rest of the window.
  const emailKey = `login:email:${parsed.data.email}`;
  const limits: Limit[] = [
    { key: emailKey, max: 10, windowMs: 15 * MINUTE },
    { key: `login:ip:${await clientIp()}`, max: 50, windowMs: 15 * MINUTE },
  ];
  if (await overLimit(limits)) redirect(`/login?error=throttled&next=${encodeURIComponent(next)}`);

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  // Verify even when the user is missing, so a wrong email takes as long as a wrong password.
  const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AA");
  if (!user || !ok) {
    await countAttempt(limits);
    redirect(back);
  }

  await clearAttempts([emailKey]);
  await createSession(user.id);
  redirect(next);
}

/** One-tap sign-in to the seeded demo studio, when the deployment allows it (DEMO_PASSWORD). */
export async function signInDemo(): Promise<void> {
  const password = process.env.DEMO_PASSWORD;
  if (!password) redirect("/login");
  const user = await prisma.user.findUnique({ where: { email: DEFAULT_USER_EMAIL } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) redirect("/login?error=demo");
  await createSession(user.id);
  redirect("/");
}

const signUpSchema = z.object({
  name: z.string().trim().min(1, "Tell us your name").max(80),
  studio: z.string().trim().max(80),
  email: z.string().trim().toLowerCase().email("That email does not look right").max(200),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function signUp(formData: FormData): Promise<void> {
  const parsed = signUpSchema.safeParse({
    name: formData.get("name"),
    studio: formData.get("studio") ?? "",
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Check the form";
    redirect(`/signup?error=${encodeURIComponent(message)}`);
  }
  const { name, email, password } = parsed.data;
  const studio = parsed.data.studio || `${name.split(/\s+/)[0]}'s studio`;

  // Ten new accounts an hour from one address is plenty for an office.
  const signupLimit: Limit[] = [{ key: `signup:ip:${await clientIp()}`, max: 10, windowMs: 60 * MINUTE }];
  if (await overLimit(signupLimit)) {
    redirect(`/signup?error=${encodeURIComponent("Too many new accounts from this network. Try again in an hour.")}`);
  }

  if (await prisma.user.findUnique({ where: { email } })) {
    redirect(`/signup?error=${encodeURIComponent("That email already has an account. Sign in instead.")}`);
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { slug: `${slugify(studio) || "studio"}-${randomBytes(3).toString("hex")}`, name: studio },
    });
    return tx.user.create({ data: { email, name, passwordHash, workspaceId: workspace.id } });
  });

  await countAttempt(signupLimit);
  await createSession(user.id);
  redirect("/?welcome=1");
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}

const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  studio: z.string().trim().min(1).max(80),
});

export async function updateProfile(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const parsed = profileSchema.safeParse({ name: formData.get("name"), studio: formData.get("studio") });
  if (!parsed.success) redirect("/account?error=1");
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { name: parsed.data.name } }),
    prisma.workspace.update({ where: { id: user.workspaceId }, data: { name: parsed.data.studio } }),
  ]);
  redirect("/account?saved=1");
}

const passwordSchema = z.object({
  current: z.string().min(1),
  password: z.string().min(8).max(200),
});

export async function changePassword(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const parsed = passwordSchema.safeParse({ current: formData.get("current"), password: formData.get("password") });
  if (!parsed.success) redirect("/account?error=password");
  const limits: Limit[] = [{ key: `password:user:${user.id}`, max: 10, windowMs: 15 * MINUTE }];
  if (await overLimit(limits)) redirect("/account?error=throttled");
  if (!(await verifyPassword(parsed.data.current, user.passwordHash))) {
    await countAttempt(limits);
    redirect("/account?error=current");
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(parsed.data.password) } });
  redirect("/account?saved=password");
}
