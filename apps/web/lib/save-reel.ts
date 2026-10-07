import { z } from "zod";
import { parseTimeline, referencedAssetIds, type Timeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { mediaScope } from "./workspace";

const saveSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(0),
  timeline: z.unknown(),
  title: z.string().trim().min(1).max(80).optional(),
});

export type SaveResult = { ok: true; revision: number } | { ok: false; reason: "conflict" | "invalid" | "missing"; message: string };

/**
 * Autosave. The write only happens if the reel is still at the revision the
 * browser last saw; otherwise another tab saved in between and this tab is
 * told to reload rather than overwriting that work.
 */
export async function saveReelFor(user: { workspaceId: string }, input: unknown): Promise<SaveResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", message: "Could not read the changes." };

  let timeline: Timeline;
  try {
    timeline = parseTimeline(parsed.data.timeline);
  } catch {
    return { ok: false, reason: "invalid", message: "The edit is not valid and was not saved." };
  }

  // Every asset in the timeline must be this workspace's or the shared library's (as export allows).
  const assetIds = referencedAssetIds(timeline);
  if (assetIds.length > 0) {
    const owned = await prisma.mediaAsset.count({ where: { id: { in: assetIds }, ...mediaScope(user.workspaceId) } });
    if (owned !== assetIds.length) return { ok: false, reason: "invalid", message: "The edit uses media from another workspace." };
  }

  const { id, revision, title } = parsed.data;
  const updated = await prisma.reel.updateMany({
    where: { id, workspaceId: user.workspaceId, revision },
    data: { timeline, revision: { increment: 1 }, ...(title ? { title } : {}) },
  });
  if (updated.count === 0) {
    const exists = await prisma.reel.count({ where: { id, workspaceId: user.workspaceId } });
    return exists
      ? { ok: false, reason: "conflict", message: "This reel was changed in another tab. Reload to see the latest version." }
      : { ok: false, reason: "missing", message: "This reel was deleted." };
  }
  return { ok: true, revision: revision + 1 };
}
