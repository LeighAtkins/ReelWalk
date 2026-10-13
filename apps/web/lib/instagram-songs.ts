import { INSTAGRAM_MUSIC_SUGGESTIONS, type AiSong } from "@reelwalk/core";
import { searchInstagramAudio } from "@/lib/instagram-audio";
import { instagramSoundProblem } from "@/lib/instagram-sound";

/**
 * The songs the AI may choose from when a studio can use Instagram's sounds
 * (ADR 0021): the first few results of each suggestion search, so the model
 * picks from what Instagram's business library actually returns rather than
 * guessing from moods. Sounds under 30 seconds are Reels snippets, not music,
 * and are left out. Searches are cached for ten minutes (instagram-audio.ts).
 */
export async function instagramSongs(workspaceId: string, perSearch = 4): Promise<AiSong[]> {
  if (await instagramSoundProblem(workspaceId)) return [];
  const results = await Promise.all(
    INSTAGRAM_MUSIC_SUGGESTIONS.map(async (suggestion) => ({ suggestion, result: await searchInstagramAudio(workspaceId, { type: "music", query: suggestion.query }) })),
  );
  const songs: AiSong[] = [];
  const seen = new Set<string>();
  for (const { suggestion, result } of results) {
    if (!result.ok) continue;
    let taken = 0;
    for (const track of result.tracks) {
      if (taken >= perSearch) break;
      if (seen.has(track.id) || (track.durationMs !== null && track.durationMs < 30_000)) continue;
      seen.add(track.id);
      taken++;
      songs.push({ id: `ig-${track.id}`, title: track.title, bpm: null, mood: suggestion.mood, instagram: track });
    }
  }
  return songs;
}
