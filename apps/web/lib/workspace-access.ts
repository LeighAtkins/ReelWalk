import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Which workspace a request acts in (ADR 0079). Pure: no database, no Next.
 *
 * A user has a home workspace (`User.workspaceId`) and may hold seats in more
 * (`WorkspaceMember`). The browser remembers the one it last switched to in a
 * signed httpOnly cookie. The cookie is only a preference: it is honoured
 * when it verifies against this very session and names a workspace the user
 * still has a seat in, and otherwise the home workspace is used. So a forged,
 * stale, replayed or revoked cookie can never widen what a person can see.
 */

export const ACTIVE_WORKSPACE_COOKIE = "rw_workspace";

export type WorkspaceRole = "OWNER" | "EDITOR";
export type Seat = { workspaceId: string; role: WorkspaceRole };

/** Home workspace first, then the rest by their order. The home workspace is the person's even when its member row is missing (an account made before the migration, or by older code during a deploy). */
export function seatsFor(homeWorkspaceId: string, rows: readonly Seat[]): Seat[] {
  const seats: Seat[] = [{ workspaceId: homeWorkspaceId, role: rows.find((row) => row.workspaceId === homeWorkspaceId)?.role ?? "OWNER" }];
  for (const row of rows) if (!seats.some((seat) => seat.workspaceId === row.workspaceId)) seats.push({ workspaceId: row.workspaceId, role: row.role });
  return seats;
}

const signature = (sessionToken: string, userId: string, workspaceId: string) =>
  createHmac("sha256", sessionToken).update(`rw-workspace:${userId}:${workspaceId}`).digest("base64url");

/** The cookie value: `<workspaceId>.<signature>`. Keyed by the session token, so it is good for this session and this person only. */
export const signActiveWorkspace = (sessionToken: string, userId: string, workspaceId: string): string =>
  `${workspaceId}.${signature(sessionToken, userId, workspaceId)}`;

/** The workspace id in a cookie value if its signature holds for this session and person, else null. */
export function readActiveWorkspace(value: string | undefined, sessionToken: string, userId: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const workspaceId = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(signature(sessionToken, userId, workspaceId));
  return given.length === expected.length && timingSafeEqual(given, expected) ? workspaceId : null;
}

/** The seat a request acts in: the cookie's workspace if it verifies and the person still has a seat there, else the home workspace. */
export function resolveSeat(input: { homeWorkspaceId: string; seats: readonly Seat[]; cookieValue: string | undefined; sessionToken: string; userId: string }): Seat {
  const home = input.seats.find((seat) => seat.workspaceId === input.homeWorkspaceId) ?? { workspaceId: input.homeWorkspaceId, role: "OWNER" as const };
  const wanted = readActiveWorkspace(input.cookieValue, input.sessionToken, input.userId);
  return (wanted && input.seats.find((seat) => seat.workspaceId === wanted)) || home;
}

/** True when the person holds a seat in `workspaceId` (the home workspace counts). */
export const hasSeat = (homeWorkspaceId: string, rows: readonly Seat[], workspaceId: string): boolean => seatsFor(homeWorkspaceId, rows).some((seat) => seat.workspaceId === workspaceId);

/** Owners change a workspace's settings and billing; editors work in its reels. */
export const canManage = (role: WorkspaceRole): boolean => role === "OWNER";

export const WORKSPACE_NAME_MAX = 60;
export const MAX_WORKSPACES_PER_USER = 5;
