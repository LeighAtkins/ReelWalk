import {
  candidatesToMatch,
  matchCandidates,
  playlistSnapshotSchema,
  scorePlaylistSnapshot,
  type AudioSearch,
  type FoundMatch,
  type InstagramAudioType,
  type PopularSoundRow,
  type ScoredCandidate,
} from "@reelwalk/core";
import type { Prisma, PrismaClient } from "@reelwalk/db";

/**
 * The "Popular now" chart (ADR 0058): scores a playlist snapshot, looks the
 * best songs up in Instagram's audio library, and stores the result as
 * MusicCandidate rows for the editor's Music sheet. Run by hand (or on a
 * schedule) with scripts/music-chart.ts; the snapshot replaces the chart.
 */

/** Most songs kept from one snapshot. */
export const STORE_LIMIT = 1000;
/** Pause between Instagram searches: about 120 in a run, well inside Graph's hourly allowance. */
export const SEARCH_PAUSE_MS = 1500;

/** What the job writes for one song. `ig` undefined: not looked up this run, keep what is stored. */
export type MusicCandidateWrite = Omit<ScoredCandidate, "popularity"> & {
  source: string;
  fetchedAt: Date;
  ig?: {
    audioId: string;
    type: InstagramAudioType;
    title: string;
    artist: string | null;
    durationMs: number | null;
    match: FoundMatch["match"]["kind"];
    confidence: number;
    trendingRank: number | null;
    bpm: number | null;
  } | null;
  matchedAt?: Date;
};

export type MusicChartStore = {
  /** Tempo of sounds someone has already analysed (MediaAsset.bpm), by Instagram audio id. */
  bpmFor(audioIds: string[]): Promise<Map<string, number>>;
  /** Writes the songs and removes stored ones that are not in the snapshot. */
  save(rows: MusicCandidateWrite[]): Promise<{ written: number; removed: number }>;
};

export type MusicChartResult = {
  songs: number;
  lookedUp: number;
  matched: number;
  covers: number;
  searches: number;
  failures: number;
  written: number;
  removed: number;
  rows: MusicCandidateWrite[];
};

/**
 * Runs the chart. `search` is null when no Instagram account is given: the
 * songs are scored and stored, but nothing is matched, so nothing is offered.
 * `dryRun` does everything but write.
 */
export async function runMusicChart(input: {
  snapshot: unknown;
  search: AudioSearch | null;
  store: MusicChartStore;
  now?: Date;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<MusicChartResult> {
  const log = input.log ?? (() => undefined);
  const now = input.now ?? new Date();
  const parsed = playlistSnapshotSchema.safeParse(input.snapshot);
  if (!parsed.success) throw new Error(`The playlist snapshot is not valid: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const snapshot = parsed.data;
  const scored = scorePlaylistSnapshot(snapshot).slice(0, STORE_LIMIT);
  log(`${snapshot.playlists.length} playlists, ${scored.length} songs scored`);

  const toMatch = input.search ? candidatesToMatch(scored) : [];
  const trending = new Map<string, number>();
  let matches = new Map<string, FoundMatch>();
  let searches = 0;
  let failures = 0;
  if (input.search) {
    for (const type of ["music", "original_sound"] as const) {
      try {
        (await input.search(type, "")).forEach((track, index) => {
          if (!trending.has(track.id)) trending.set(track.id, index + 1);
        });
      } catch (error) {
        log(`trending ${type}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`looking up ${toMatch.length} songs on Instagram`);
    ({ matches, searches, failures } = await matchCandidates(toMatch, input.search));
  }

  // Tempo is a nicety: without it the editor measures the sound once it is picked.
  const bpm = await input.store.bpmFor([...new Set([...matches.values()].map((found) => found.sound.id))]).catch((error: unknown) => {
    log(`tempo lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return new Map<string, number>();
  });
  const lookedUp = new Set(toMatch.map((candidate) => candidate.key));
  const rows: MusicCandidateWrite[] = scored.map((candidate) => {
    // The source's popularity is already in the score; it is not stored on its own.
    const row: MusicCandidateWrite = {
      key: candidate.key,
      isrc: candidate.isrc,
      title: candidate.title,
      artist: candidate.artist,
      score: candidate.score,
      moods: candidate.moods,
      playlists: candidate.playlists,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
    };
    if (!lookedUp.has(candidate.key)) return row;
    const found = matches.get(candidate.key);
    row.matchedAt = now;
    row.ig = found
      ? {
          audioId: found.sound.id,
          type: found.sound.type,
          title: found.sound.title,
          artist: found.sound.artist,
          durationMs: found.sound.durationMs,
          match: found.match.kind,
          confidence: found.match.confidence,
          trendingRank: trending.get(found.sound.id) ?? null,
          bpm: bpm.get(found.sound.id) ?? null,
        }
      : null;
    return row;
  });

  const matched = rows.filter((row) => row.ig);
  const saved = input.dryRun ? { written: 0, removed: 0 } : await input.store.save(rows);
  return {
    songs: scored.length,
    lookedUp: toMatch.length,
    matched: matched.length,
    covers: matched.filter((row) => row.ig?.match === "cover").length,
    searches,
    failures,
    ...saved,
    rows,
  };
}

/** A search that waits between calls, so a run never bursts at Instagram. */
export function pacedSearch(search: AudioSearch, pauseMs = SEARCH_PAUSE_MS, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): AudioSearch {
  let last = 0;
  return async (type, query) => {
    const wait = last + pauseMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await search(type, query);
    } finally {
      last = Date.now();
    }
  };
}

/** A matched row as the picks read it (rows not looked up this run are skipped). */
export function popularRowFromWrite(row: MusicCandidateWrite): PopularSoundRow | null {
  if (!row.ig) return null;
  return {
    key: row.key,
    title: row.title,
    artist: row.artist,
    score: row.score,
    moods: row.moods,
    playlists: row.playlists,
    igAudioId: row.ig.audioId,
    igAudioType: row.ig.type,
    igTitle: row.ig.title,
    igArtist: row.ig.artist,
    igDurationMs: row.ig.durationMs,
    igMatch: row.ig.match,
    trendingRank: row.ig.trendingRank,
    bpm: row.ig.bpm,
  };
}

/** The store over the database. */
export function prismaMusicChartStore(prisma: PrismaClient): MusicChartStore {
  return {
    async bpmFor(audioIds) {
      if (audioIds.length === 0) return new Map();
      const assets = await prisma.mediaAsset.findMany({
        where: { instagramAudioId: { in: audioIds }, bpm: { not: null } },
        select: { instagramAudioId: true, bpm: true },
      });
      return new Map(assets.map((asset) => [asset.instagramAudioId!, asset.bpm!]));
    },
    async save(rows) {
      for (let start = 0; start < rows.length; start += 100) {
        await prisma.$transaction(
          rows.slice(start, start + 100).map((row) => {
            const data = {
              isrc: row.isrc,
              title: row.title.slice(0, 300),
              artist: row.artist.slice(0, 300),
              score: row.score,
              moods: row.moods as Prisma.InputJsonValue,
              playlists: row.playlists as unknown as Prisma.InputJsonValue,
              source: row.source,
              fetchedAt: row.fetchedAt,
              ...(row.ig === undefined
                ? {}
                : {
                    igAudioId: row.ig?.audioId ?? null,
                    igAudioType: row.ig?.type ?? null,
                    igTitle: row.ig?.title.slice(0, 300) ?? null,
                    igArtist: row.ig?.artist?.slice(0, 300) ?? null,
                    igDurationMs: row.ig?.durationMs ?? null,
                    igMatch: row.ig?.match ?? null,
                    igConfidence: row.ig?.confidence ?? null,
                    trendingRank: row.ig?.trendingRank ?? null,
                    bpm: row.ig?.bpm ?? null,
                    matchedAt: row.matchedAt ?? null,
                  }),
            };
            return prisma.musicCandidate.upsert({ where: { key: row.key }, update: data, create: { key: row.key, ...data } });
          }),
        );
      }
      const removed = await prisma.musicCandidate.deleteMany({ where: { key: { notIn: rows.map((row) => row.key) } } });
      return { written: rows.length, removed: removed.count };
    },
  };
}

