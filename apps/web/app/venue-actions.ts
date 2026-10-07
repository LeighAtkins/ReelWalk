"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { buildVenueReel, captionForVenue, thumbKeyFor, uploadKeyFor, venueDetailsSchema, venueVibeById } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { toLibraryAsset, type LibraryAsset } from "@/lib/library";
import { getStock, isStockConfigured, searchStock, STOCK_LICENSE, stockCredit, type StockVideo } from "@/lib/stock";
import { putObject } from "@/lib/storage";
import { getCurrentUser, mediaScope } from "@/lib/workspace";

// ── Venue reels ─────────────────────────────────────────────────

const venueRequestSchema = z.object({
  vibeId: z.string().min(1),
  assetIds: z.array(z.string().min(1)).min(2).max(10),
  details: venueDetailsSchema,
});

export type VenueRequest = z.input<typeof venueRequestSchema>;

/**
 * Builds a restaurant or café reel from the clips the user tapped, in that
 * order, plus the dishes and the vibe. The result is an ordinary reel: it
 * opens in the editor and can be changed like any other.
 */
export async function createVenueReel(input: VenueRequest): Promise<{ id: string } | { error: string }> {
  const parsed = venueRequestSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const { vibeId, assetIds, details } = parsed.data;
  const vibe = venueVibeById(vibeId);
  if (!vibe) return { error: "Pick a vibe." };

  const user = await getCurrentUser();
  const assets = await prisma.mediaAsset.findMany({
    where: { ...mediaScope(user.workspaceId), id: { in: assetIds }, kind: { in: ["VIDEO", "IMAGE"] } },
    select: { id: true, kind: true, durationMs: true, attribution: true },
  });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const clips = assetIds.flatMap((id) => {
    const asset = byId.get(id);
    return asset ? [{ assetId: asset.id, kind: asset.kind as "VIDEO" | "IMAGE", durationMs: asset.durationMs }] : [];
  });
  if (clips.length < 2) return { error: "Pick at least two clips or photos." };

  const song =
    (await prisma.mediaAsset.findFirst({ where: { ...mediaScope(user.workspaceId), kind: "AUDIO", objectKey: `library/music/${vibe.song}.mp3` } })) ??
    (await prisma.mediaAsset.findFirst({ where: { ...mediaScope(user.workspaceId), kind: "AUDIO", bpm: { not: null } }, orderBy: { fileName: "asc" } }));
  const timeline = buildVenueReel({
    clips,
    details,
    vibe,
    music: song ? { assetId: song.id, sourceStartMs: 0, volume: 0.8, bpm: song.bpm, beatOffsetMs: song.beatOffsetMs } : null,
  });
  if (!timeline) return { error: "Pick at least two clips or photos." };

  // Stock clips carry a credit; it joins the music credit in the caption.
  const credits = [...new Set(assets.map((asset) => asset.attribution).filter((value): value is string => !!value && /Pixabay/.test(value)))];
  const caption = [captionForVenue(vibe, details, song?.attribution), ...credits].join("\n");

  const reel = await prisma.reel.create({
    data: { workspaceId: user.workspaceId, title: `${details.name}: ${vibe.name}`.slice(0, 80), caption, timeline },
  });
  revalidatePath("/");
  return { id: reel.id };
}

// ── Stock footage ───────────────────────────────────────────────

export type StockSearchResult = { ok: true; videos: StockVideo[] } | { ok: false; error: string; unconfigured?: boolean };

export async function searchStockVideos(query: string): Promise<StockSearchResult> {
  await getCurrentUser();
  if (!isStockConfigured()) return { ok: false, unconfigured: true, error: "Stock search needs a free Pixabay API key (PIXABAY_API_KEY)." };
  const q = query.trim();
  if (q.length < 2) return { ok: true, videos: [] };
  try {
    return { ok: true, videos: await searchStock(q) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Stock search failed." };
  }
}

/**
 * Copies a stock clip into the workspace's library: the MP4 and its poster
 * frame go to storage, the row keeps the source URL, licence and credit.
 * Importing the same clip twice returns the existing asset.
 */
export async function importStockVideo(input: { id: number }): Promise<{ ok: true; asset: LibraryAsset } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!isStockConfigured()) return { ok: false, error: "Stock search is not set up." };
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Unknown clip." };

  const sourceUrl = `https://pixabay.com/videos/${id}/`;
  const existing = await prisma.mediaAsset.findFirst({ where: { workspaceId: user.workspaceId, sourceUrl } });
  if (existing) return { ok: true, asset: await toLibraryAsset(existing) };

  try {
    const video = await getStock(id);
    if (!video.file) return { ok: false, error: "That clip has no usable MP4." };
    const [media, poster] = await Promise.all([download(video.file.url, 400 * 1024 * 1024), download(video.image, 8 * 1024 * 1024).catch(() => null)]);

    const objectKey = uploadKeyFor(user.workspaceId, randomUUID(), "mp4");
    const thumbKey = poster ? thumbKeyFor(objectKey) : null;
    await putObject(objectKey, media, "video/mp4");
    if (poster && thumbKey) await putObject(thumbKey, poster, "image/jpeg");

    const asset = await prisma.mediaAsset.create({
      data: {
        workspaceId: user.workspaceId,
        kind: "VIDEO",
        objectKey,
        thumbKey,
        contentType: "video/mp4",
        fileName: `pixabay-${video.id}.mp4`,
        sizeBytes: media.byteLength,
        durationMs: video.durationMs,
        width: video.file.width,
        height: video.file.height,
        sourceUrl,
        license: STOCK_LICENSE,
        attribution: stockCredit(video),
      },
    });
    return { ok: true, asset: await toLibraryAsset(asset) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not import the clip." };
  }
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
