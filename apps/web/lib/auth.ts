import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { prisma } from "@reelwalk/db";
import { actingUser } from "./mcp/acting-user";
import { ACTIVE_WORKSPACE_COOKIE, resolveSeat, seatsFor, signActiveWorkspace } from "./workspace-access";

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
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    expires: expiresAt,
  });
  // A new sign-in starts in the home workspace (ADR 0079).
  store.delete(ACTIVE_WORKSPACE_COOKIE);
}

/** Remembers the workspace this browser works in. The caller has already checked the person's seat; the cookie is signed for this session and person, and read back through the seats again on every request. Server Actions and Route Handlers only. */
export async function setActiveWorkspace(userId: string, workspaceId: string): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return;
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  store.set(ACTIVE_WORKSPACE_COOKIE, signActiveWorkspace(token, userId, workspaceId), { httpOnly: true, sameSite: "lax", secure: secureCookies(), path: "/", expires });
}

/** Signs this browser out. Other devices stay signed in. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { id: hashToken(token) } });
  store.delete(SESSION_COOKIE);
  store.delete(ACTIVE_WORKSPACE_COOKIE);
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

/**
 * The signed-in user acting in their active workspace, or null. Cached per request.
 *
 * `workspaceId` and `workspace` are the ACTIVE workspace (ADR 0079): the one
 * the browser switched to if the person still has a seat there, else their
 * home workspace. Every page, route and action that scopes by
 * `user.workspaceId` therefore follows the switcher without a change. The home
 * workspace is `homeWorkspaceId`; `role` is the seat in the active one.
 */
export const getSessionUser = cache(async () => {
  // A connector request (ADR 0077) acts as the person its bearer token belongs to; it never reads a cookie.
  const acting = actingUser();
  if (acting) return acting;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: { include: { workspace: true, memberships: { include: { workspace: true } } } } },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  const { memberships, ...user } = session.user;
  const seats = seatsFor(user.workspaceId, memberships);
  const seat = resolveSeat({ homeWorkspaceId: user.workspaceId, seats, cookieValue: (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value, sessionToken: token, userId: user.id });
  const workspace = seat.workspaceId === user.workspaceId ? user.workspace : (memberships.find((row) => row.workspaceId === seat.workspaceId)?.workspace ?? user.workspace);
  return { ...user, homeWorkspaceId: user.workspaceId, workspaceId: workspace.id, workspace, role: seat.role };
});
