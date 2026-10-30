import { checksKeyFor, exportAudioKeyFor } from "@reelwalk/core";
import type { PrismaClient } from "./generated/prisma/client";

/**
 * The objects render runs upload before they know whether they will win the
 * job (ADR 0094). Each run writes keys of its own (a preview, its frame
 * thumbnail, an export), so a run that loses the job (moved to the cloud, or
 * taken over) or dies leaves files nothing points at. Every such key is
 * recorded here BEFORE its upload, so even a run that dies mid-upload leaves a
 * record; the web app's sweep deletes the ones nothing references once they are
 * older than any run could still be using them, and account deletion takes
 * them all.
 */
export type RenderArtifactKind = "run" | "cache";

type Db = Pick<PrismaClient, "renderArtifact">;

/**
 * Records a key a run is about to upload. A key can come round again (an
 * export's key repeats when a failed job is retried), so recording it again
 * makes it new: the sweep never deletes a key a run has just started writing.
 */
export async function recordRenderArtifact(db: Db, artifact: { key: string; kind?: RenderArtifactKind; workspaceId: string; jobId: string }): Promise<void> {
  const row = { kind: "run", ...artifact };
  await db.renderArtifact.upsert({ where: { key: artifact.key }, create: row, update: { ...row, createdAt: new Date() } }).catch(async (error: { code?: string }) => {
    // Two runs recording the same key at once: the other insert won; make it new all the same.
    if (error.code !== "P2002") throw error;
    await db.renderArtifact.update({ where: { key: artifact.key }, data: { createdAt: new Date() } });
  });
}

/** What an export key brings with it: its checks and its audio trace, written beside it. */
export function artifactCompanions(key: string): string[] {
  return /(^|\/)renders\/[^/]+\.mp4$/.test(key) ? [key, checksKeyFor(key), exportAudioKeyFor(key)] : [key];
}

/** Every recorded object of these workspaces, with an export's companions: for account deletion. */
export async function renderArtifactKeys(db: Db, workspaceIds: string[]): Promise<string[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db.renderArtifact.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { key: true } });
  return rows.flatMap((row) => artifactCompanions(row.key));
}

/**
 * Deletes run objects nothing references, `graceMs` after they were recorded
 * (far longer than any render or the fallback takes, so no run still writing
 * or publishing loses its file). Referenced means a media asset's preview or
 * thumbnail, or a render output: those rows are only written by the run that
 * won (store.succeed). A referenced object's record is dropped (it is the
 * asset's or output's now, and goes with them); an unreferenced one is deleted
 * from storage, then its record. "cache" records (render sources) are never
 * swept. Returns the keys deleted.
 */
export async function sweepRenderArtifacts(
  prisma: PrismaClient,
  options: { graceMs: number; now?: Date; limit?: number; deleteObjects: (keys: string[]) => Promise<void> },
): Promise<string[]> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - options.graceMs);
  const due = await prisma.renderArtifact.findMany({
    where: { kind: "run", createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 100,
    select: { id: true, key: true },
  });
  if (due.length === 0) return [];
  const keys = due.map((row) => row.key);
  const [assets, outputs] = await Promise.all([
    prisma.mediaAsset.findMany({ where: { OR: [{ previewKey: { in: keys } }, { thumbKey: { in: keys } }] }, select: { previewKey: true, thumbKey: true } }),
    prisma.renderOutput.findMany({ where: { objectKey: { in: keys } }, select: { objectKey: true } }),
  ]);
  const referenced = new Set([...assets.flatMap((asset) => [asset.previewKey, asset.thumbKey]), ...outputs.map((output) => output.objectKey)]);
  // Referenced: the record has served its purpose.
  await prisma.renderArtifact.deleteMany({ where: { id: { in: due.filter((row) => referenced.has(row.key)).map((row) => row.id) } } });
  // Unreferenced: the record goes first, and only if it is still old. A run that recorded the key again in the
  // meantime (a retry writing the same key) has made it new, and its file is left alone.
  const deleted: string[] = [];
  for (const row of due.filter((candidate) => !referenced.has(candidate.key))) {
    const { count } = await prisma.renderArtifact.deleteMany({ where: { id: row.id, createdAt: { lt: cutoff } } });
    if (count === 1) deleted.push(row.key);
  }
  if (deleted.length > 0) await options.deleteObjects(deleted.flatMap(artifactCompanions));
  return deleted;
}
