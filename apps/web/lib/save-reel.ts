import { z } from "zod";
import { keepSavedTextFields, parseTimeline, referencedAssetIds, timelineSchema, type Timeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { FenceRefused, currentSaveFence, type Tx } from "./save-fence";
import { mediaScope } from "./workspace";

const saveSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(0),
  timeline: z.unknown(),
  title: z.string().trim().min(1).max(80).optional(),
});

export type SaveResult = { ok: true; revision: number } | { ok: false; reason: "conflict" | "invalid" | "missing" | "fenced"; message: string };

/**
 * Autosave. The write only happens if the reel is still at the revision the
 * browser last saw; otherwise another tab saved in between and this tab is
 * told to reload rather than overwriting that work.
 */
export async function saveReelFor(user: { workspaceId: string }, input: unknown, options: { exact?: boolean } = {}): Promise<SaveResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", message: "Could not read the changes." };

  // Texts keep the saved values of fields the save leaves out (an explicit null clears one); see keepSavedTextFields.
  // `exact` replaces the whole timeline instead (going back to an export's cut, ADR 0095): nothing of the current one survives.
  const current = options.exact ? null : await prisma.reel.findFirst({ where: { id: parsed.data.id, workspaceId: user.workspaceId }, select: { timeline: true } });
  const before = current ? timelineSchema.safeParse(current.timeline) : null;
  let timeline: Timeline;
  try {
    timeline = parseTimeline(options.exact ? parsed.data.timeline : keepSavedTextFields(parsed.data.timeline, before?.success ? before.data : null));
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
  const write = async (db: Tx | typeof prisma): Promise<SaveResult> => {
    const updated = await db.reel.updateMany({
      where: { id, workspaceId: user.workspaceId, revision },
      data: { timeline, revision: { increment: 1 }, ...(title ? { title } : {}) },
    });
    if (updated.count > 0) return { ok: true, revision: revision + 1 };
    const exists = await db.reel.count({ where: { id, workspaceId: user.workspaceId } });
    return exists
      ? { ok: false, reason: "conflict", message: "This reel was changed in another tab. Reload to see the latest version." }
      : { ok: false, reason: "missing", message: "This reel was deleted." };
  };
  // A note's save (ADR 0095): the note says, in the write's own transaction, whether it may land, and records it with it.
  const fence = currentSaveFence();
  if (!fence) return write(prisma);
  try {
    return await prisma.$transaction(
      async (tx) => {
        const stopped = await fence.lock(tx);
        if (stopped) return { ok: false, reason: "fenced", message: stopped } satisfies SaveResult;
        // The reel's row next (the note, then the reel: one order everywhere), so the write below waits for nobody.
        await tx.$queryRaw`SELECT 1 AS locked FROM "Reel" WHERE id = ${id} AND "workspaceId" = ${user.workspaceId} FOR UPDATE`;
        const late = await fence.inTime(tx);
        if (late) return { ok: false, reason: "fenced", message: late } satisfies SaveResult;
        const saved = await write(tx);
        if (!saved.ok) return saved;
        const after = await fence.inTime(tx);
        if (after) throw new FenceRefused(after);
        await fence.committed(tx, saved.revision);
        return saved;
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    if (error instanceof FenceRefused) return { ok: false, reason: "fenced", message: error.message };
    throw error;
  }
}
