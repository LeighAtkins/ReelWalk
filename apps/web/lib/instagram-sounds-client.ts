import type { InstagramAudioTrack, MusicMoodId, PopularPick } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

/** Browser side of /api/instagram/sounds: stays working on a page left open across a deploy. */
async function call<T>(body: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    const response = await fetch("/api/instagram/sounds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export function searchSounds(input: { type: string; query: string }) {
  return call<{ ok: true; tracks: InstagramAudioTrack[] } | { ok: false; error: string }>({ action: "search", ...input }, { ok: false, error: "Could not reach ReelWalk. Check the connection and try again." });
}

export function chooseSound(input: { audioId: string; type: string; title: string; artist: string | null }) {
  return call<{ ok: true; asset: LibraryAsset } | { ok: false; error: string }>({ action: "choose", ...input }, { ok: false, error: "Could not reach ReelWalk. Check the connection and try again." });
}

/** The Music sheet's "Popular now" row (ADR 0058); empty on any failure, so the row just stays hidden. */
export async function popularSoundsFor(input: { moods: MusicMoodId[]; reelMs: number }): Promise<PopularPick[]> {
  const result = await call<{ ok: true; picks: PopularPick[] } | { ok: false }>({ action: "popular", ...input }, { ok: false });
  return result.ok && Array.isArray(result.picks) ? result.picks : [];
}
