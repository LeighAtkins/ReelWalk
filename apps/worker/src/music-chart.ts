import {
  candidatesToMatch,
  isGraphRateLimit,
  matchCandidates,
  playlistSnapshotSchema,
  scorePlaylistSnapshot,
  type AudioSearch,
  type FoundMatch,
  type InstagramAudioType,
  type MatchRun,
  type PopularSoundRow,
  type ScoredCandidate,
} from "@reelwalk/core";
import type { Prisma, PrismaClient } from "@reelwalk/db";

/**
 * The "Popular now" chart (ADR 0058): scores a playlist snapshot, looks the
 * best songs up in Instagram's audio library, and stores the result as
 * MusicCandidate rows for the editor's Music sheet. Run by hand (or on a
 * schedule) with scripts/music-chart.ts; the snapshot replaces the chart.
 *
 * Safety: Instagram is searched only with the house account (the script
 * checks it); rate limiting stops the run before anything is written; a
 * failed search keeps the song's stored match; the save is one transaction
 * under an advisory lock, and refuses a snapshot that would shrink the chart
 * by more than half unless forced.
 */

/** Most songs kept from one snapshot. */
export const STORE_LIMIT = 1000;
/** Pause between Instagram searches: about 120 in a run, well inside Graph's hourly allowance. */
export const SEARCH_PAUSE_MS = 1500;

export type CandidateMatch = {
  audioId: string;
  type: InstagramAudioType;
  title: string;
  artist: string | null;
  durationMs: number | null;
  match: FoundMatch["match"]["kind"];
  confidence: number;
  trendingRank: number | null;
  bpm: number | null;
};

/** What the job writes for one song. `ig` undefined: not (successfully) looked up this run, keep what is stored. */
export type MusicCandidateWrite = Omit<ScoredCandidate, "popularity"> & {
  source: string;
  fetchedAt: Date;
  ig?: CandidateMatch | null;
  matchedAt?: Date;
};

export type StoredMatch = { key: string; ig: CandidateMatch | null; matchedAt: Date | null };

export type SaveResult = { written: number; removed: number; kept: number };

export type MusicChartStore = {
  /** Tempo of sounds someone has already analysed (MediaAsset.bpm), by Instagram audio id. */
  bpmFor(audioIds: string[]): Promise<Map<string, number>>;
  /**
   * Replaces the chart with these songs, atomically. Songs with `ig`
   * undefined keep their stored match. Throws MusicChartRefused when
   * another run holds the lock or the guard refuses.
   */
  save(rows: MusicCandidateWrite[], options: { force: boolean }): Promise<SaveResult>;
};

/** A save the job would not do; the stored chart is untouched. */
export class MusicChartRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicChartRefused";
  }
}

/** A new chart smaller than this share of the stored one needs --force: more likely a broken snapshot than a real change. */
export const MIN_REPLACEMENT_SHARE = 0.5;

/** Why replacing a chart of `current` songs with `next` is refused, or null when it may go ahead. */
export function chartReplacementProblem(current: number, next: number, force: boolean): string | null {
  if (force || current === 0 || next >= current * MIN_REPLACEMENT_SHARE) return null;
  return `The new snapshot has ${next} songs, under half of the ${current} stored. Check it, then run again with --force to replace the chart anyway.`;
}

/** Songs not (successfully) looked up this run take their stored match; every row comes back with `ig` set or null. */
export function mergeKeptMatches(rows: MusicCandidateWrite[], stored: StoredMatch[]): { rows: MusicCandidateWrite[]; kept: number } {
  const byKey = new Map(stored.map((entry) => [entry.key, entry]));
  let kept = 0;
  const merged = rows.map((row) => {
    if (row.ig !== undefined) return row;
    const previous = byKey.get(row.key);
    if (previous?.ig) kept++;
    return { ...row, ig: previous?.ig ?? null, matchedAt: previous?.matchedAt ?? undefined };
  });
  return { rows: merged, kept };
}

/** Instagram's handle for the house account, unless MUSIC_HOUSE_IG_USERNAME says otherwise. */
export const HOUSE_IG_USERNAME = "reelwalking";

/** The house account is the only one the job searches with, never a customer's token. Null when this account is it. */
export function houseAccountProblem(account: { username: string; expiresAt: Date | null } | null, expectedUsername: string, now = new Date()): string | null {
  if (!account) return "The house workspace (MUSIC_HOUSE_WORKSPACE_ID) has no connected Instagram account.";
  const username = account.username.replace(/^@/, "").toLowerCase();
  const expected = expectedUsername.replace(/^@/, "").toLowerCase();
  if (username !== expected) return `The house workspace's Instagram account is @${username}, not @${expected}: refusing to search with anyone else's account.`;
  if (account.expiresAt && account.expiresAt.getTime() < now.getTime()) return "The house workspace's Instagram connection has expired. Reconnect it on the Account tab.";
  return null;
}

export type MusicChartResult = SaveResult & {
  songs: number;
  lookedUp: number;
  matched: number;
  covers: number;
  searches: number;
  failures: number;
  /** Why the run stopped before writing (rate limited), or null. */
  stopped: string | null;
  rows: MusicCandidateWrite[];
};

/**
 * Runs the chart. `search` is null when no Instagram account is given: the
 * songs are scored and stored with their stored matches kept, nothing new is
 * matched. `dryRun` does everything but write.
 */
export async function runMusicChart(input: {
  snapshot: unknown;
  search: AudioSearch | null;
  store: MusicChartStore;
  now?: Date;
  dryRun?: boolean;
  /** Replace the chart even when the snapshot is much smaller than it. */
  force?: boolean;
  /** Errors that stop the run with nothing written. Graph's rate limiting by default. */
  stopOn?: (error: unknown) => boolean;
  log?: (line: string) => void;
}): Promise<MusicChartResult> {
  const log = input.log ?? (() => undefined);
  const stopOn = input.stopOn ?? isGraphRateLimit;
  const now = input.now ?? new Date();
  const parsed = playlistSnapshotSchema.safeParse(input.snapshot);
  if (!parsed.success) throw new Error(`The playlist snapshot is not valid: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const snapshot = parsed.data;
  const scored = scorePlaylistSnapshot(snapshot).slice(0, STORE_LIMIT);
  log(`${snapshot.playlists.length} playlists, ${scored.length} songs scored`);

  const toMatch = input.search ? candidatesToMatch(scored) : [];
  const trending = new Map<string, number>();
  let run: MatchRun = { matches: new Map(), checked: new Set(), failed: new Set(), searches: 0, failures: 0, stopped: null };
  if (input.search) {
    for (const type of ["music", "original_sound"] as const) {
      try {
        (await input.search(type, "")).forEach((track, index) => {
          if (!trending.has(track.id)) trending.set(track.id, index + 1);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (stopOn(error)) {
          run.stopped = message;
          break;
        }
        log(`trending ${type}: ${message}`);
      }
    }
    if (!run.stopped) {
      log(`looking up ${toMatch.length} songs on Instagram`);
      run = await matchCandidates(toMatch, input.search, { stopOn });
    }
  }
  const stopped = run.stopped ? `Instagram is rate limiting (${run.stopped}). Stopped before writing anything; the stored chart is unchanged. Run again later.` : null;

  // Tempo is a nicety: without it the editor measures the sound once it is picked.
  const bpm = stopped
    ? new Map<string, number>()
    : await input.store.bpmFor([...new Set([...run.matches.values()].map((found) => found.sound.id))]).catch((error: unknown) => {
        log(`tempo lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        return new Map<string, number>();
      });
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
    // Not looked up, or a search failed: the stored match stands (mergeKeptMatches).
    if (!run.checked.has(candidate.key)) return row;
    const found = run.matches.get(candidate.key);
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
  const summary = {
    songs: scored.length,
    lookedUp: run.checked.size + run.failed.size,
    matched: matched.length,
    covers: matched.filter((row) => row.ig?.match === "cover").length,
    searches: run.searches,
    failures: run.failures,
    stopped,
    rows,
  };
  if (stopped || input.dryRun) return { ...summary, written: 0, removed: 0, kept: 0 };
  return { ...summary, ...(await input.store.save(rows, { force: input.force ?? false })) };
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

/** A matched row as the picks read it (rows with no match this run are skipped). */
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

/** Advisory lock id for chart saves (ADR 0058). */
const MUSIC_CHART_LOCK = 580_058;

type StoredRow = {
  key: string;
  igAudioId: string | null;
  igAudioType: string | null;
  igTitle: string | null;
  igArtist: string | null;
  igDurationMs: number | null;
  igMatch: string | null;
  igConfidence: number | null;
  trendingRank: number | null;
  bpm: number | null;
  matchedAt: Date | null;
};

export function storedMatch(entry: StoredRow): StoredMatch {
  const usable =
    entry.igAudioId !== null &&
    entry.igTitle !== null &&
    (entry.igAudioType === "music" || entry.igAudioType === "original_sound") &&
    (entry.igMatch === "track" || entry.igMatch === "cover");
  return {
    key: entry.key,
    matchedAt: entry.matchedAt,
    ig: usable
      ? {
          audioId: entry.igAudioId!,
          type: entry.igAudioType as InstagramAudioType,
          title: entry.igTitle!,
          artist: entry.igArtist,
          durationMs: entry.igDurationMs,
          match: entry.igMatch as CandidateMatch["match"],
          confidence: entry.igConfidence ?? 0,
          trendingRank: entry.trendingRank,
          bpm: entry.bpm,
        }
      : null,
  };
}

function rowData(row: MusicCandidateWrite): Prisma.MusicCandidateCreateManyInput {
  return {
    key: row.key,
    isrc: row.isrc,
    title: row.title.slice(0, 300),
    artist: row.artist.slice(0, 300),
    score: row.score,
    moods: row.moods as Prisma.InputJsonValue,
    playlists: row.playlists as unknown as Prisma.InputJsonValue,
    source: row.source,
    fetchedAt: row.fetchedAt,
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
    async save(rows, { force }) {
      return prisma.$transaction(
        async (tx) => {
          // One save at a time. A second run is told to try again rather than queued behind the first.
          const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${MUSIC_CHART_LOCK}::bigint) AS locked`;
          if (!lock?.locked) throw new MusicChartRefused("Another music-chart run is saving right now. Try again when it has finished.");
          const stored = await tx.musicCandidate.findMany({
            select: { key: true, igAudioId: true, igAudioType: true, igTitle: true, igArtist: true, igDurationMs: true, igMatch: true, igConfidence: true, trendingRank: true, bpm: true, matchedAt: true },
          });
          const problem = chartReplacementProblem(stored.length, rows.length, force);
          if (problem) throw new MusicChartRefused(problem);
          const { rows: merged, kept } = mergeKeptMatches(rows, stored.map(storedMatch));
          // The swap: readers see the old chart or the new one, never a mix, and any failure keeps the old one.
          await tx.musicCandidate.deleteMany({});
          await tx.musicCandidate.createMany({ data: merged.map(rowData) });
          const next = new Set(merged.map((row) => row.key));
          return { written: merged.length, removed: stored.filter((entry) => !next.has(entry.key)).length, kept };
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    },
  };
}
