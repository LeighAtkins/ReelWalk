"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { buildVenueReel, captionForVenue, venueDetailsSchema, venueVibeById, songMapFields } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import type { LibraryAsset } from "@/lib/library";
import { isStockConfigured, searchStock, type StockVideo } from "@/lib/stock";
import { importStockClip } from "@/lib/stock-import";
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
    // Never an Instagram sound's private copy (ADR 0019): it is only for editing against.
    (await prisma.mediaAsset.findFirst({ where: { ...mediaScope(user.workspaceId), kind: "AUDIO", bpm: { not: null }, instagramAudioId: null }, orderBy: { fileName: "asc" } }));
  const timeline = buildVenueReel({
    clips,
    details,
    vibe,
    // A new reel's song carries its bars and sections, with "On the beat" on (ADR 0059).
    music: song ? { assetId: song.id, sourceStartMs: 0, volume: 0.8, bpm: song.bpm, beatOffsetMs: song.beatOffsetMs, ...songMapFields(song.songMap), onBeat: true } : null,
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
  return importStockClip(user.workspaceId, Number(input.id));
}
