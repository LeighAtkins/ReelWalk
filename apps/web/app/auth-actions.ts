"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DEFAULT_USER_EMAIL, hashPassword, prisma, verifyPassword } from "@reelwalk/db";
import { checksKeyFor, exportAudioKeyFor, frameThumbKeyFor, renderSourceKeyFor, thumbKeyFor } from "@reelwalk/core";
import { pickAttribution, withAttribution } from "@/lib/attribution";
import { createSession, destroySession } from "@/lib/auth";
import { slugify } from "@/lib/slug";
import { loadSeats } from "@/lib/workspaces";
import { canManage } from "@/lib/workspace-access";
import { recordFunnelEvent } from "@/lib/funnel";
import { deleteObjects } from "@/lib/storage";
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

export async function signUp(formData: FormData): Promise<void> {
  // A refused form comes back with the same utm and click ids, so the next try is still attributed (ADR 0080).
  const attribution = pickAttribution(formData);
  const back = (message: string) => withAttribution(`/signup?error=${encodeURIComponent(message)}`, attribution);
  const parsed = signUpSchema.safeParse({
    name: formData.get("name"),
    studio: formData.get("studio") ?? "",
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Check the form";
    redirect(back(message));
  }
  const { name, email, password } = parsed.data;
  const studio = parsed.data.studio || `${name.split(/\s+/)[0]}'s studio`;

  // Ten new accounts an hour from one address is plenty for an office.
  const signupLimit: Limit[] = [{ key: `signup:ip:${await clientIp()}`, max: 10, windowMs: 60 * MINUTE }];
  if (await overLimit(signupLimit)) {
    redirect(back("Too many new accounts from this network. Try again in an hour."));
  }

  if (await prisma.user.findUnique({ where: { email } })) {
    redirect(back("That email already has an account. Sign in instead."));
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { slug: `${slugify(studio) || "studio"}-${randomBytes(3).toString("hex")}`, name: studio },
    });
    const created = await tx.user.create({ data: { email, name, passwordHash, workspaceId: workspace.id, ...(attribution ? { attribution } : {}) } });
    await tx.workspaceMember.create({ data: { userId: created.id, workspaceId: workspace.id, role: "OWNER" } });
    return created;
  });

  await countAttempt(signupLimit);
  await recordFunnelEvent({ name: "signup", userId: user.id, workspaceId: user.workspaceId, key: `signup:${user.id}` });
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
    // Only an owner renames a workspace (ADR 0079).
    ...(canManage(user.role) ? [prisma.workspace.update({ where: { id: user.workspaceId }, data: { name: parsed.data.studio } })] : []),
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

/**
 * Deletes the signed-in user's account: the studio, every reel, upload,
 * preview and export, in the database and in storage. Asks for the password
 * again, so a borrowed phone cannot do it.
 */
export async function deleteAccount(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const limits: Limit[] = [{ key: `password:user:${user.id}`, max: 10, windowMs: 15 * MINUTE }];
  if (await overLimit(limits)) redirect("/account?error=throttled#delete");
  const password = String(formData.get("password") ?? "");
  if (formData.get("confirm") !== "yes") redirect("/account?error=confirm#delete");
  if (!(await verifyPassword(password, user.passwordHash))) {
    await countAttempt(limits);
    redirect("/account?error=delete-password#delete");
  }

  // Workspaces that go with the person (ADR 0079): every one where they are the only soul left, home workspace
  // included. One that anybody else still uses (another sign-in with it as home, or another seat) is kept for them.
  const seats = await loadSeats(user.id, user.homeWorkspaceId);
  const goingWith: string[] = [];
  for (const seat of seats) {
    const [otherUsers, otherSeats] = await Promise.all([
      prisma.user.count({ where: { workspaceId: seat.workspaceId, id: { not: user.id } } }),
      prisma.workspaceMember.count({ where: { workspaceId: seat.workspaceId, userId: { not: user.id } } }),
    ]);
    if (otherUsers === 0 && otherSeats === 0) goingWith.push(seat.workspaceId);
  }
  // Collect the files first: the rows that name them go with the workspace.
  const [media, outputs] = await Promise.all([
    prisma.mediaAsset.findMany({ where: { workspaceId: { in: goingWith }, shared: false }, select: { id: true, objectKey: true, thumbKey: true, previewKey: true } }),
    prisma.renderOutput.findMany({ where: { job: { workspaceId: { in: goingWith } } }, select: { objectKey: true } }),
  ]);
  const keys = [
    ...media.flatMap((asset) => [asset.objectKey, asset.thumbKey, asset.previewKey, renderSourceKeyFor(asset.id), thumbKeyFor(asset.objectKey), frameThumbKeyFor(asset.objectKey)]),
    ...outputs.flatMap((output) => [output.objectKey, checksKeyFor(output.objectKey), exportAudioKeyFor(output.objectKey)]),
  ].filter((key): key is string => Boolean(key));
  // Everything else (sessions, reels, media rows, render jobs and outputs, connected accounts, seats) cascades from
  // the workspace or the user; the user row goes last, whether or not their home workspace went with them.
  await prisma.workspace.deleteMany({ where: { id: { in: goingWith } } });
  await prisma.user.deleteMany({ where: { id: user.id } });
  await deleteObjects(keys).catch((error) => console.error(`deleteAccount: ${keys.length} objects not deleted for ${goingWith.join(",")}`, error));
  await destroySession();
  redirect("/login?deleted=1");
}

