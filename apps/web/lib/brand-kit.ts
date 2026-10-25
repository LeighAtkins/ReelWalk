import { readBrandKit, type BrandKit } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";

/**
 * The workspace's brand kit (ADR 0078), or null: none assigned, the stored JSON no longer valid, or the `brandKit` column
 * not there yet (the migration is applied by hand, not by the deploy). A kit is a nicety on top of editing, so reading
 * it never throws and never breaks the editor or the commands route.
 */
export async function workspaceBrandKit(workspaceId: string): Promise<BrandKit | null> {
  try {
    const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { brandKit: true } });
    return readBrandKit(row?.brandKit);
  } catch {
    return null;
  }
}
