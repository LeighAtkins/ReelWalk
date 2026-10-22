import { randomUUID } from "node:crypto";
import { stockCreditLine, thumbKeyFor, uploadKeyFor } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { toLibraryAsset, type LibraryAsset } from "@/lib/library";
import { getStockClip, isStockConfigured, STOCK_LICENSE, type StockHit } from "@/lib/stock";
import { putObject } from "@/lib/storage";

/**
 * Copies a stock clip into a workspace's library (ADR 0070): the MP4 and its
 * poster go to storage; the asset row keeps the clip's page URL, licence and
 * credit, and its creation time is the import time, which together are the
 * licence record (`stockSource` in @reelwalk/core reads it back). Importing
 * the same clip twice returns the existing asset. Used by the venue builder,
 * the editor's Stock tab and `POST /api/stock/import`.
 */
export type ImportResult = { ok: true; asset: LibraryAsset; existing: boolean } | { ok: false; error: string };

const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
const MAX_POSTER_BYTES = 8 * 1024 * 1024;

export async function importStockClip(workspaceId: string, id: number, known?: StockHit): Promise<ImportResult> {
  if (!isStockConfigured()) return { ok: false, error: "Stock search is not set up." };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Unknown clip." };

  const sourceUrl = `https://pixabay.com/videos/${id}/`;
  const existing = await prisma.mediaAsset.findFirst({ where: { workspaceId, sourceUrl } });
  if (existing) return { ok: true, asset: await toLibraryAsset(existing), existing: true };

  try {
    const clip = known ?? (await getStockClip(id));
    if (!clip.file) return { ok: false, error: "That clip has no usable MP4." };
    const [media, poster] = await Promise.all([download(clip.file.url, MAX_VIDEO_BYTES), download(clip.poster, MAX_POSTER_BYTES).catch(() => null)]);

    const objectKey = uploadKeyFor(workspaceId, randomUUID(), "mp4");
    const thumbKey = poster ? thumbKeyFor(objectKey) : null;
    await putObject(objectKey, media, "video/mp4");
    if (poster && thumbKey) await putObject(thumbKey, poster, "image/jpeg");

    const asset = await prisma.mediaAsset.create({
      data: {
        workspaceId,
        kind: "VIDEO",
        objectKey,
        thumbKey,
        contentType: "video/mp4",
        fileName: `${clip.source}-${clip.id}.mp4`,
        sizeBytes: media.byteLength,
        durationMs: clip.durationMs,
        width: clip.file.width,
        height: clip.file.height,
        sourceUrl,
        license: STOCK_LICENSE,
        attribution: stockCreditLine(clip),
      },
    });
    return { ok: true, asset: await toLibraryAsset(asset), existing: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not import the clip." };
  }
}

/** Imports a set, a few at a time, in the order given; failures are reported by clip and do not stop the rest. */
export async function importStockClips(workspaceId: string, ids: number[], concurrency = 3): Promise<{ assets: LibraryAsset[]; failed: { id: number; error: string }[] }> {
  const results: (ImportResult & { id: number })[] = new Array(ids.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (next < ids.length) {
      const at = next++;
      results[at] = { id: ids[at], ...(await importStockClip(workspaceId, ids[at])) };
    }
  }));
  return {
    assets: results.flatMap((result) => (result.ok ? [result.asset] : [])),
    failed: results.flatMap((result) => (result.ok ? [] : [{ id: result.id, error: result.error }])),
  };
}

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new Error("That clip is too large to import.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("That clip is too large to import.");
  return bytes;
}
