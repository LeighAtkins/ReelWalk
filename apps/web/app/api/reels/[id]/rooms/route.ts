import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { labelRooms } from "@/lib/room-labels";

export const dynamic = "force-dynamic";

/**
 * Names the rooms of a reel's shots as soon as they are up (ADR 0022), so the
 * studio sees and can correct them before the reel is made. Shots already
 * named come back with their names; nothing is changed on the reel itself.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false }, { status: 401 });
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true } });
  if (!reel) return Response.json({ ok: false }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { assetIds?: unknown };
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds.filter((value): value is string => typeof value === "string").slice(0, 40) : [];
  await labelRooms(user.workspaceId, assetIds);
  const rows = await prisma.mediaAsset.findMany({ where: { id: { in: assetIds }, workspaceId: user.workspaceId }, select: { id: true, room: true } });
  return Response.json({ ok: true, rooms: Object.fromEntries(rows.filter((row) => row.room).map((row) => [row.id, row.room])) });
}
