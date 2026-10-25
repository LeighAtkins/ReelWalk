import { randomBytes } from "node:crypto";
import { prisma } from "@reelwalk/db";
import type { ActingUser } from "./mcp/acting-user";
import { aiSwitchOf, type AiSwitch } from "./ai-gate";
import { slugify } from "./slug";
import { MAX_WORKSPACES_PER_USER, WORKSPACE_NAME_MAX, seatsFor, type Seat, type WorkspaceRole } from "./workspace-access";

/**
 * Workspaces from the database's side (ADR 0079): a person's seats, the list
 * the switcher shows, creating a workspace, and the one place a connector
 * token turns into "this person, acting in that workspace".
 */

/** Every seat the person holds, home workspace first. */
export async function loadSeats(userId: string, homeWorkspaceId: string): Promise<Seat[]> {
  const rows = await prisma.workspaceMember.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { workspaceId: true, role: true } });
  return seatsFor(homeWorkspaceId, rows);
}

/** The person's role in a workspace, or null when they have no seat there (a workspace that is not theirs does not exist to them). */
export async function seatRole(userId: string, homeWorkspaceId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  return (await loadSeats(userId, homeWorkspaceId)).find((seat) => seat.workspaceId === workspaceId)?.role ?? null;
}

export type WorkspaceChoice = { id: string; name: string; slug: string; role: WorkspaceRole; home: boolean; active: boolean; ai: AiSwitch };

/** The workspaces the switcher lists, home first. `activeId` marks the current one. */
export async function listWorkspaces(user: { id: string; homeWorkspaceId: string }, activeId: string): Promise<WorkspaceChoice[]> {
  const seats = await loadSeats(user.id, user.homeWorkspaceId);
  const rows = await prisma.workspace.findMany({ where: { id: { in: seats.map((seat) => seat.workspaceId) } }, select: { id: true, name: true, slug: true, aiGeneration: true } });
  return seats.flatMap((seat) => {
    const row = rows.find((candidate) => candidate.id === seat.workspaceId);
    return row ? [{ id: row.id, name: row.name, slug: row.slug, role: seat.role, home: seat.workspaceId === user.homeWorkspaceId, active: row.id === activeId, ai: aiSwitchOf(row.aiGeneration) }] : [];
  });
}

export type CreateWorkspaceResult = { ok: true; id: string } | { ok: false; message: string };

/** A new workspace the person owns (they hold an OWNER seat; their home workspace does not change). */
export async function createWorkspaceFor(userId: string, homeWorkspaceId: string, rawName: string): Promise<CreateWorkspaceResult> {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (name.length < 1) return { ok: false, message: "Give the workspace a name." };
  if (name.length > WORKSPACE_NAME_MAX) return { ok: false, message: `Keep the name under ${WORKSPACE_NAME_MAX} characters.` };
  const seats = await loadSeats(userId, homeWorkspaceId);
  if (seats.length >= MAX_WORKSPACES_PER_USER) return { ok: false, message: `${MAX_WORKSPACES_PER_USER} workspaces is the most one sign-in can hold.` };
  const workspace = await prisma.$transaction(async (tx) => {
    const created = await tx.workspace.create({ data: { slug: `${slugify(name) || "workspace"}-${randomBytes(3).toString("hex")}`, name } });
    await tx.workspaceMember.create({ data: { userId, workspaceId: created.id, role: "OWNER" } });
    return created;
  });
  return { ok: true, id: workspace.id };
}

/**
 * The person a connector grant acts as, in the workspace the grant is bound to
 * (ADR 0079), or null when the person is gone or no longer holds a seat there.
 * Called on every connector request, so removing someone from a workspace
 * cuts their connection to it at the next call.
 */
export async function actingUserFor(userId: string, workspaceId: string): Promise<ActingUser | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { workspace: true, memberships: { where: { workspaceId }, include: { workspace: true } } } });
  if (!user) return null;
  const { memberships, ...person } = user;
  if (workspaceId === user.workspaceId) return { ...person, homeWorkspaceId: user.workspaceId, role: memberships[0]?.role ?? "OWNER" };
  const seat = memberships[0];
  if (!seat) return null;
  return { ...person, homeWorkspaceId: user.workspaceId, workspaceId: seat.workspace.id, workspace: seat.workspace, role: seat.role };
}
