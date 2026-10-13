import { INSTAGRAM_AUDIO_QUERY_MAX, instagramAudioIdFromQuery, searchFakeInstagramAudio, type InstagramAudioTrack, type InstagramAudioType } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { fetchInstagramAudio, fetchInstagramAudioById, instagramErrorMessage, isFakeInstagram, isInstagramConfigured } from "./instagram";

/**
 * Searching Instagram's audio library for the "Instagram sound" picker
 * (ADR 0018), with the workspace's connected account.
 *
 * Results are cached per process for ten minutes per workspace, type and
 * query: typing in the search box and switching tabs would otherwise call
 * Instagram for every keystroke and every switch back. Preview links last
 * about a day and a half, so ten minutes old is still playable.
 */

export type AudioSearchResult = { ok: true; tracks: InstagramAudioTrack[] } | { ok: false; error: string };

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; tracks: InstagramAudioTrack[] }>();

function cached(key: string, now: number): InstagramAudioTrack[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.tracks;
}

function remember(key: string, tracks: InstagramAudioTrack[], now: number): void {
  // Oldest first: a Map iterates in insertion order.
  while (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, tracks });
}

/** Normalises the search text: trimmed, single spaces, at most 100 characters. */
export function normaliseAudioQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, INSTAGRAM_AUDIO_QUERY_MAX);
}

/** Searches with the workspace's Instagram account. Never throws; errors come back in words. */
export async function searchInstagramAudio(workspaceId: string, input: { type: InstagramAudioType; query: string }): Promise<AudioSearchResult> {
  const query = normaliseAudioQuery(input.query);
  if (isFakeInstagram()) return { ok: true, tracks: searchFakeInstagramAudio(input.type, query) };
  if (!isInstagramConfigured()) return { ok: false, error: "Instagram posting is not set up on this deployment." };

  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } } });
  if (!account) return { ok: false, error: "Connect an Instagram professional account first (Account tab)." };
  if (account.expiresAt && account.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "Your Instagram connection has expired. Reconnect it on the Account tab." };
  }

  const key = `${workspaceId}\u0000${account.externalId}\u0000${input.type}\u0000${query.toLowerCase()}`;
  const now = Date.now();
  const hit = cached(key, now);
  if (hit) return { ok: true, tracks: hit };

  try {
    // A pasted audio link or id loads that exact sound, whichever tab is open.
    const linkedId = instagramAudioIdFromQuery(query);
    const tracks = linkedId
      ? await fetchInstagramAudioById({ igUserId: account.externalId, token: account.accessToken, id: linkedId, type: input.type })
      : await fetchInstagramAudio({ igUserId: account.externalId, token: account.accessToken, type: input.type, query });
    remember(key, tracks, now);
    return { ok: true, tracks };
  } catch (error) {
    console.error("instagram audio: search failed", error);
    if (instagramAudioIdFromQuery(query)) {
      return { ok: false, error: "Instagram does not let this account use that sound. Business accounts only get sounds cleared for business use." };
    }
    return { ok: false, error: instagramErrorMessage(error, "Instagram's sound library did not answer. Try again in a moment.") };
  }
}
