import { pickPopularSounds, popularSoundRowFromStored, type MusicMoodId, type PopularPick, type PopularSoundRow } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";

/**
 * "Popular now" in the Music sheet (ADR 0058): the best stored, matched
 * songs for the reel's moods. Only MusicCandidate rows the chart job wrote
 * can come back, so nothing is ever made up; an empty list hides the row.
 * The rows are read once a minute per process: they change when the job
 * runs, not per request.
 */

const CACHE_TTL_MS = 60_000;
/** Matched rows read per refresh: the best few hundred are plenty to fill five slots for any mood. */
const ROWS = 300;
let cache: { at: number; rows: PopularSoundRow[] } | null = null;

async function matchedRows(now: number): Promise<PopularSoundRow[]> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows;
  const stored = await prisma.musicCandidate.findMany({
    where: { igAudioId: { not: null } },
    orderBy: { score: "desc" },
    take: ROWS,
    select: {
      key: true,
      title: true,
      artist: true,
      score: true,
      moods: true,
      playlists: true,
      igAudioId: true,
      igAudioType: true,
      igTitle: true,
      igArtist: true,
      igDurationMs: true,
      igMatch: true,
      trendingRank: true,
      bpm: true,
    },
  });
  const rows = stored.map(popularSoundRowFromStored).filter((row): row is PopularSoundRow => row !== null);
  cache = { at: now, rows };
  return rows;
}

/**
 * Up to five sounds for a reel, each with its why line. The tempo is the
 * workspace's own measurement of the sound when it has one, else the
 * chart's. Never throws: no data, or a database hiccup, is an empty row.
 */
export async function popularSounds(workspaceId: string, input: { moods: MusicMoodId[]; reelMs: number }): Promise<PopularPick[]> {
  try {
    const picks = pickPopularSounds(await matchedRows(Date.now()), { moods: input.moods, reelMs: input.reelMs, limit: 5 });
    if (picks.length === 0) return picks;
    const own = await prisma.mediaAsset.findMany({
      where: { workspaceId, instagramAudioId: { in: picks.map((pick) => pick.track.id) }, bpm: { not: null } },
      select: { instagramAudioId: true, bpm: true },
    });
    const bpm = new Map(own.map((asset) => [asset.instagramAudioId!, asset.bpm!]));
    return picks.map((pick) => ({ ...pick, bpm: bpm.get(pick.track.id) ?? pick.bpm }));
  } catch (error) {
    console.error("music picks: could not read the chart", error);
    return [];
  }
}
