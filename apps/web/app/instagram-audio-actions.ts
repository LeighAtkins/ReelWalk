"use server";

import { z } from "zod";
import { isInstagramAudioType } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { searchInstagramAudio, type AudioSearchResult } from "@/lib/instagram-audio";
import { ensureInstagramSoundAsset, instagramSoundProblem } from "@/lib/instagram-sound";
import { toLibraryAsset, type LibraryAsset } from "@/lib/library";
import { postingProblem } from "@/lib/scheduled-posts";
import { mediaUrl } from "@/lib/storage";
import { getCurrentUser } from "@/lib/workspace";

/** The "Instagram sound" picker's search: music or trending sounds, trending when the query is empty. */
export async function searchInstagramSounds(input: { type: string; query: string }): Promise<AudioSearchResult> {
  const user = await getCurrentUser();
  if (!isInstagramAudioType(input.type)) return { ok: false, error: "Unknown kind of sound." };
  const problem = await postingProblem(user.workspaceId);
  if (problem) return { ok: false, error: problem };
  return searchInstagramAudio(user.workspaceId, { type: input.type, query: String(input.query ?? "") });
}

const soundSchema = z.object({
  audioId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/),
  type: z.string().refine(isInstagramAudioType).default("music"),
  title: z.string().trim().min(1).max(200),
  artist: z.string().trim().max(200).nullish().transform((value) => value || null),
});

type SoundInput = z.input<typeof soundSchema>;

async function soundAsset(input: SoundInput) {
  const parsed = soundSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "That Instagram sound could not be read. Pick it again." };
  const user = await getCurrentUser();
  const problem = await instagramSoundProblem(user.workspaceId);
  if (problem) return { ok: false as const, error: problem };
  const { type, ...sound } = parsed.data;
  return ensureInstagramSoundAsset(user.workspaceId, { ...sound, type: isInstagramAudioType(type) ? type : "music" });
}

/**
 * The editor's Music sheet: makes (or reuses) the workspace's private copy of
 * an Instagram sound and returns it as a library asset to put under the reel.
 */
export async function chooseInstagramSound(input: SoundInput): Promise<{ ok: true; asset: LibraryAsset } | { ok: false; error: string }> {
  const result = await soundAsset(input);
  return result.ok ? { ok: true, asset: await toLibraryAsset(result.asset) } : result;
}

/**
 * The export screen's "Play with sound": a link the browser can play the
 * sound from, through the same private copy the editor uses.
 */
export async function instagramSoundPlayback(input: SoundInput): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const result = await soundAsset(input);
  return result.ok ? { ok: true, url: await mediaUrl(result.asset.objectKey) } : result;
}

const analysisSchema = z.object({
  assetId: z.string().min(1).max(64),
  durationMs: z.number().int().positive().max(60 * 60_000).nullable(),
  bpm: z.number().min(40).max(240).nullable(),
  beatOffsetMs: z.number().int().min(0).nullable(),
  /** Instagram's own length of the sound, to tell a clip from the whole track in the logs. */
  catalogueMs: z.number().int().positive().nullable().optional(),
});

/**
 * Length and tempo of an Instagram sound's copy, measured in the browser
 * after decoding it (the server never decodes audio), so cuts can snap to
 * its beat. Only the workspace's own Instagram copies can be changed.
 */
export async function analyseInstagramSound(input: z.input<typeof analysisSchema>): Promise<{ ok: boolean }> {
  const parsed = analysisSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  const user = await getCurrentUser();
  const { assetId, durationMs, bpm, beatOffsetMs, catalogueMs } = parsed.data;
  const updated = await prisma.mediaAsset.updateMany({
    where: { id: assetId, workspaceId: user.workspaceId, instagramAudioId: { not: null } },
    data: { durationMs, bpm, beatOffsetMs },
  });
  if (updated.count > 0 && durationMs && catalogueMs) {
    // Whether Instagram's preview is the whole sound or a clip of it (ADR 0019).
    console.log(`instagram sound: preview ${(durationMs / 1000).toFixed(1)} s of a ${(catalogueMs / 1000).toFixed(1)} s sound`);
  }
  return { ok: updated.count > 0 };
}
