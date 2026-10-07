import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { prisma } from "@reelwalk/db";

/**
 * Sessions live in Postgres. The browser holds a random token in an httpOnly
 * cookie; the table stores only its SHA-256, so a database read-out does not
 * hand out working sessions.
 */

export const SESSION_COOKIE = "rw_session";
const SESSION_DAYS = 30;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Secure cookies need HTTPS. Local Compose and the LAN run on plain HTTP. */
function secureCookies(): boolean {
  if (process.env.AUTH_SECURE_COOKIES) return process.env.AUTH_SECURE_COOKIES === "true";
  return (process.env.APP_URL ?? "").startsWith("https://");
}

/** Signs a browser in: one Session row and the cookie that points at it. Server Actions and Route Handlers only. */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  const userAgent = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  await prisma.session.create({ data: { id: hashToken(token), userId, expiresAt, userAgent } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    expires: expiresAt,
  });
}

/** Signs this browser out. Other devices stay signed in. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { id: hashToken(token) } });
  store.delete(SESSION_COOKIE);
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

/** The signed-in user with their workspace, or null. Cached per request. */
export const getSessionUser = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: { include: { workspace: true } } },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return session.user;
});
