import { z } from "zod";
import type { InstagramAudioTrack, InstagramAudioType } from "./instagram-audio";
import type { Filter, Timeline } from "./timeline";

/**
 * "Popular now" (ADR 0058): music people actually listen to, limited to what
 * Instagram lets a business account attach.
 *
 * The ground truth is a playlist snapshot: public playlists found per mood
 * search, with their follower counts and their tracks in order. A track's
 * score is the sum, over the playlists it is in, of log(1 + followers)
 * times a position weight, plus the track's own popularity when the source
 * has one. The best candidates are then matched, strictly, against
 * Instagram's audio library; only matched ones are ever offered, and only
 * from stored rows, so nothing here (or any model) can invent a track.
 *
 * Everything in this file is pure; the worker job (apps/worker
 * src/music-chart.ts) does the fetching and storing.
 */

// ── Moods ───────────────────────────────────────────────────────

/**
 * The moods a reel can have, each with the search used to find playlists
 * for it and the words in a reel (title, rooms, titles on screen) that
 * suggest it. Words are matched as whole words, lower case.
 */
export const MUSIC_MOODS = [
  {
    id: "luxury-home-tour",
    label: "Luxury home tour",
    seed: "luxury home tour",
    words: ["luxury", "penthouse", "estate", "mansion", "villa", "marble", "chandelier", "wine cellar", "cinema", "gated", "waterfront", "skyline", "exclusive", "grand", "million"],
  },
  {
    id: "summer-house",
    label: "Summer house",
    seed: "summer house",
    words: ["pool", "beach", "summer", "lagoon", "ocean", "sea view", "coast", "coastal", "sunset", "terrace", "patio", "palm", "island", "tropical", "lake", "dock", "boat"],
  },
  {
    id: "cozy-winter",
    label: "Cozy winter",
    seed: "cozy winter",
    words: ["snow", "snowy", "winter", "cabin", "lodge", "fireplace", "chalet", "ski", "cosy", "cozy", "log", "forest", "mountain", "christmas", "fire pit", "sauna", "woods"],
  },
  {
    id: "upbeat-real-estate",
    label: "Upbeat real estate",
    seed: "upbeat real estate",
    words: ["just listed", "open house", "new listing", "sold", "for sale", "must see", "don't miss", "starter", "first home", "keys", "move in", "price drop", "bonus room"],
  },
  {
    id: "chill-piano",
    label: "Chill piano",
    seed: "chill piano",
    words: ["calm", "quiet", "slow", "library", "study", "reading", "morning", "minimal", "zen", "spa", "bath", "garden", "nursery", "peaceful"],
  },
  {
    id: "deep-house",
    label: "Deep house",
    seed: "deep house",
    words: ["night", "rooftop", "loft", "modern", "city", "downtown", "bar", "party", "neon", "lounge", "skyline", "urban", "condo"],
  },
] as const;

export type MusicMoodId = (typeof MUSIC_MOODS)[number]["id"];
export const MUSIC_MOOD_IDS = MUSIC_MOODS.map((mood) => mood.id) as [MusicMoodId, ...MusicMoodId[]];

export function isMusicMood(value: unknown): value is MusicMoodId {
  return typeof value === "string" && (MUSIC_MOOD_IDS as readonly string[]).includes(value);
}

/** When nothing in a reel suggests a mood: a listing reel, polished. */
export const DEFAULT_MUSIC_MOOD: MusicMoodId = "luxury-home-tour";

/** Looks lean a reel's mood a little; words count for more. */
const FILTER_MOODS: Partial<Record<Filter, MusicMoodId>> = {
  golden: "summer-house",
  warm: "summer-house",
  cool: "cozy-winter",
  mono: "chill-piano",
  fade: "chill-piano",
  dusk: "deep-house",
};

/** What a reel says about itself: its title, the rooms its clips show, its words on screen and its looks. */
export type ReelMoodInput = { title?: string | null; words: string[]; filters?: Filter[] };

export function reelMoodInput(timeline: Timeline, title?: string | null): ReelMoodInput {
  const words: string[] = [];
  for (const clip of timeline.clips) if (clip.room) words.push(clip.room);
  for (const text of timeline.texts) words.push(text.text);
  if (timeline.hook) words.push(timeline.hook.title, timeline.hook.body);
  return { title: title ?? null, words, filters: timeline.clips.map((clip) => clip.filter) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The reel's moods, best first, at most two. A word in the title counts
 * double; each look counts half once. Nothing recognised: the default.
 */
export function reelMoods(input: ReelMoodInput): MusicMoodId[] {
  const body = ` ${input.words.join(" \n ").toLowerCase()} `;
  const title = ` ${(input.title ?? "").toLowerCase()} `;
  const scores = new Map<MusicMoodId, number>();
  for (const mood of MUSIC_MOODS) {
    let score = 0;
    for (const word of mood.words) {
      const pattern = new RegExp(`(^|[^a-z])${escapeRegExp(word)}([^a-z]|$)`);
      if (pattern.test(title)) score += 2;
      if (pattern.test(body)) score += 1;
    }
    if (score > 0) scores.set(mood.id, score);
  }
  for (const filter of new Set(input.filters ?? [])) {
    const mood = FILTER_MOODS[filter];
    if (mood) scores.set(mood, (scores.get(mood) ?? 0) + 0.5);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || MUSIC_MOOD_IDS.indexOf(a[0]) - MUSIC_MOOD_IDS.indexOf(b[0]));
  // A lone half point from a look is not enough to call a mood.
  const moods = ranked.filter(([, score]) => score >= 1).map(([id]) => id).slice(0, 2);
  return moods.length > 0 ? moods : [DEFAULT_MUSIC_MOOD];
}

// ── The playlist snapshot ───────────────────────────────────────

const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** An ISRC in its canonical form (no dashes, upper case), or null when it is not one. */
export function normaliseIsrc(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/[-\s]/g, "").toUpperCase();
  return isrcPattern.test(text) ? text : null;
}

const snapshotTrackSchema = z.object({
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().min(1).max(300),
  isrc: z.string().nullish().transform((value) => normaliseIsrc(value)),
  /** The source's own 0-100 popularity, when it has one. */
  popularity: z.number().min(0).max(100).nullish().transform((value) => value ?? null),
});

const snapshotPlaylistSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  followers: z.number().int().min(0),
  /** The mood searches that found it. */
  moods: z.array(z.enum(MUSIC_MOOD_IDS)).min(1),
  url: z.string().url().nullish().transform((value) => value ?? null),
  /** In playlist order, first is position 1. */
  tracks: z.array(snapshotTrackSchema).max(2000),
});

/**
 * A playlist snapshot, from a licensed chart-data source or curated by
 * hand (ADR 0058 explains why ReelWalk does not read Spotify's API for it).
 */
export const playlistSnapshotSchema = z.object({
  /** Where it came from, stored on every candidate ("chartmetric 2026-10-21", "hand-curated"). */
  source: z.string().trim().min(1).max(120),
  fetchedAt: z.coerce.date(),
  playlists: z.array(snapshotPlaylistSchema).max(2000),
});
export type PlaylistSnapshot = z.infer<typeof playlistSnapshotSchema>;
export type SnapshotPlaylist = z.infer<typeof snapshotPlaylistSchema>;

// ── Normalising titles and artists ──────────────────────────────

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function tidy(text: string): string {
  return text
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words in brackets or after " - " that name a release of a song rather than another song. */
const RELEASE_WORDS = /\b(feat|ft|featuring|with|remaster|remastered|radio edit|edit|single version|album version|version|original mix|extended mix|mono|stereo|live|from|soundtrack|ost)\b/;

/**
 * A song title reduced to the song: lower case, no accents, without
 * "(feat. …)", "- Remastered 2011", "(Radio Edit)" and similar. A remix
 * keeps its name: it is a different recording.
 */
export function normaliseTitle(title: string): string {
  let text = fold(title);
  text = text.replace(/[([{]([^)\]}]*)[)\]}]/g, (whole, inner: string) => (RELEASE_WORDS.test(inner) && !/\bremix\b/.test(inner) ? " " : whole));
  text = text.replace(/\s[-–—]\s(.*)$/, (whole, rest: string) => (RELEASE_WORDS.test(rest) && !/\bremix\b/.test(rest) ? " " : whole));
  text = text.replace(/\s(feat|ft|featuring)\.?\s.*$/, " ");
  return tidy(text);
}

/** The first credited artist, folded: "Calvin Harris, Dua Lipa" and "Calvin Harris feat. X" are both "calvin harris". */
export function normaliseArtist(artist: string | null | undefined): string {
  const text = fold(artist ?? "").replace(/^@/, "");
  const first = text.split(/\s*(?:,|;|\/|\s&\s|\sx\s|\sand\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\swith\s|\svs\.?\s)\s*/)[0] ?? "";
  return tidy(first).replace(/^the /, "");
}

/** Levenshtein distance, two rows. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** 1 for the same text, 0 for nothing in common: 1 - distance / longer length. Empty against anything is 0. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

// ── Scoring ─────────────────────────────────────────────────────

/** How much a slot in a playlist counts: 1 at the top, 0.63 second, 0.5 third, 0.25 at 15th (1 / log2(position + 1)). */
export function positionWeight(position: number): number {
  return 1 / Math.log2(Math.max(1, position) + 1);
}

/** How much a playlist counts: ln(1 + followers). A million followers is 13.8, a thousand 6.9. */
export function playlistWeight(followers: number): number {
  return Math.log(1 + Math.max(0, followers));
}

/** A track's own 0-100 popularity is worth at most this much: about a third of the top slot in a big playlist. */
export const POPULARITY_WEIGHT = 5;
/** Being in Instagram's own trending list is worth at most this much (at rank 1). */
export const TRENDING_WEIGHT = 4;

/** The same song under two spellings (or with and without an ISRC) is one candidate. */
export function titleArtistKey(title: string, artist: string): string {
  return `${normaliseTitle(title)}|${normaliseArtist(artist)}`;
}

export type CandidatePlaylist = { id: string; name: string; followers: number; position: number };

/** A scored song from the snapshot, before matching. */
export type ScoredCandidate = {
  /** Stable across runs: "isrc:<ISRC>" when any copy had one, else "ta:<title>|<artist>". */
  key: string;
  isrc: string | null;
  title: string;
  artist: string;
  score: number;
  moods: MusicMoodId[];
  /** Biggest following first. */
  playlists: CandidatePlaylist[];
  popularity: number | null;
};

/**
 * Scores every song in the snapshot and merges duplicates. A playlist found
 * by two mood searches (listed twice) counts once, and a song listed twice in
 * one playlist counts at its best position. Highest score first.
 */
export function scorePlaylistSnapshot(snapshot: PlaylistSnapshot): ScoredCandidate[] {
  // One entry per playlist id, moods merged.
  const playlists = new Map<string, SnapshotPlaylist>();
  for (const playlist of snapshot.playlists) {
    const known = playlists.get(playlist.id);
    if (known) known.moods = [...new Set([...known.moods, ...playlist.moods])];
    else playlists.set(playlist.id, { ...playlist, moods: [...playlist.moods] });
  }

  type Working = Omit<ScoredCandidate, "key" | "score" | "playlists"> & { byPlaylist: Map<string, CandidatePlaylist>; titleKey: string };
  const all: Working[] = [];
  const byIsrc = new Map<string, Working>();
  const byTitle = new Map<string, Working>();

  for (const playlist of playlists.values()) {
    playlist.tracks.forEach((track, index) => {
      const titleKey = titleArtistKey(track.title, track.artist);
      if (titleKey.startsWith("|") || titleKey.endsWith("|")) return;
      let entry = (track.isrc ? byIsrc.get(track.isrc) : undefined) ?? byTitle.get(titleKey);
      if (!entry) {
        entry = { isrc: null, title: track.title, artist: track.artist, moods: [], popularity: null, byPlaylist: new Map(), titleKey };
        all.push(entry);
      }
      if (track.isrc && !entry.isrc) entry.isrc = track.isrc;
      if (entry.isrc) byIsrc.set(entry.isrc, entry);
      byTitle.set(titleKey, entry);
      for (const mood of playlist.moods) if (!entry.moods.includes(mood)) entry.moods.push(mood);
      if (track.popularity !== null) entry.popularity = Math.max(entry.popularity ?? 0, track.popularity);
      const position = index + 1;
      const seen = entry.byPlaylist.get(playlist.id);
      if (!seen || position < seen.position) entry.byPlaylist.set(playlist.id, { id: playlist.id, name: playlist.name, followers: playlist.followers, position });
    });
  }

  return all
    .map((entry) => {
      const listed = [...entry.byPlaylist.values()].sort((a, b) => b.followers - a.followers || a.position - b.position);
      const fromPlaylists = listed.reduce((sum, playlist) => sum + playlistWeight(playlist.followers) * positionWeight(playlist.position), 0);
      const fromPopularity = entry.popularity === null ? 0 : (entry.popularity / 100) * POPULARITY_WEIGHT;
      return {
        key: entry.isrc ? `isrc:${entry.isrc}` : `ta:${entry.titleKey}`,
        isrc: entry.isrc,
        title: entry.title,
        artist: entry.artist,
        score: round(fromPlaylists + fromPopularity),
        moods: [...entry.moods].sort((a, b) => MUSIC_MOOD_IDS.indexOf(a) - MUSIC_MOOD_IDS.indexOf(b)),
        playlists: listed,
        popularity: entry.popularity,
      };
    })
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The bonus for appearing in Instagram's trending list at a 1-based rank. */
export function trendingBonus(rank: number | null | undefined): number {
  return rank && rank > 0 ? round(TRENDING_WEIGHT * positionWeight(rank)) : 0;
}

/**
 * Which candidates are worth looking up on Instagram: the best `perMood` of
 * each mood, so a mood with smaller playlists is not crowded out, at most
 * `limit` in all, best first.
 */
export function candidatesToMatch<T extends { key: string; score: number; moods: MusicMoodId[] }>(candidates: T[], perMood = 12, limit = 60): T[] {
  const chosen = new Map<string, T>();
  for (const mood of MUSIC_MOOD_IDS) {
    for (const candidate of candidates.filter((entry) => entry.moods.includes(mood)).slice(0, perMood)) chosen.set(candidate.key, candidate);
  }
  return [...chosen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Matching against Instagram ──────────────────────────────────

/**
 * How alike a title and an artist must be to call an Instagram track the
 * same recording. Strict on purpose: a wrong match puts a stranger's song
 * under a popularity it never earned. 0.92 lets one typo in a dozen letters
 * through, not "Levitating" for "Elevating".
 */
export const MATCH_THRESHOLDS = { title: 0.92, artist: 0.85, coverTitle: 0.95 } as const;

/** Words that mark a creator's sound as a cover of a song. */
const COVER_MARKERS = /\b(piano|cover|covered|version|instrumental|acoustic|violin|cello|guitar|strings|orchestral|lofi|lo fi|remake|rendition)\b/;
/** Words removed from a cover's title before comparing it with the song's. */
const COVER_WORDS = /\b(piano|cover|covered|version|instrumental|acoustic|violin|cello|guitar|strings|orchestral|lofi|lo fi|remake|rendition|solo|tutorial|original audio|original sound)\b/g;

export type MatchKind = "track" | "cover";
export type InstagramMatch = { kind: MatchKind; confidence: number };
export type MatchableSound = Pick<InstagramAudioTrack, "type" | "title" | "artist"> & { isrc?: string | null };

/**
 * Whether an Instagram sound is the candidate song: the same recording
 * ("track": music with the same title and first artist, or the same ISRC),
 * or a creator's cover of it ("cover": an original sound whose title is the
 * song's title plus a cover word such as "piano", or plus the song's
 * artist). Null when it is neither.
 */
export function matchInstagramSound(candidate: { title: string; artist: string; isrc?: string | null }, sound: MatchableSound): InstagramMatch | null {
  const isrc = normaliseIsrc(candidate.isrc);
  if (isrc && normaliseIsrc(sound.isrc) === isrc) return { kind: "track", confidence: 1 };

  const songTitle = normaliseTitle(candidate.title);
  const songArtist = normaliseArtist(candidate.artist);
  if (!songTitle) return null;

  if (sound.type === "music") {
    const title = similarity(songTitle, normaliseTitle(sound.title));
    const artist = similarity(songArtist, normaliseArtist(sound.artist));
    if (title >= MATCH_THRESHOLDS.title && artist >= MATCH_THRESHOLDS.artist) return { kind: "track", confidence: round(Math.min(title, artist)) };
    return null;
  }

  // An original sound: a creator's recording, credited to the creator. Only a cover of the song can match.
  const raw = tidy(fold(sound.title));
  if (!raw || raw === "original audio" || raw === "original sound") return null;
  const hasMarker = COVER_MARKERS.test(raw);
  const fullArtist = tidy(fold(candidate.artist));
  const namesArtist = songArtist.length >= 3 && (` ${raw} `.includes(` ${songArtist} `) || (fullArtist.length >= 3 && ` ${raw} `.includes(` ${fullArtist} `)));
  if (!hasMarker && !namesArtist) return null;
  // A one-word title ("Home", "Experience") is too common to trust without the artist's name as well.
  if (!songTitle.includes(" ") && !namesArtist) return null;
  let rest = normaliseTitle(sound.title);
  for (const name of [fullArtist, songArtist]) if (name.length >= 3) rest = ` ${rest} `.replace(` ${name} `, " ");
  // "Piano cover of Stand By Me", "Stand By Me piano version by": the joining word is left dangling at an end.
  rest = rest.replace(COVER_WORDS, " ").replace(/\s+/g, " ").trim().replace(/^(of|by)\s+/, "").replace(/\s+(of|by)$/, "");
  const title = similarity(songTitle, rest);
  return title >= MATCH_THRESHOLDS.coverTitle ? { kind: "cover", confidence: round(title) } : null;
}

/** Sounds shorter than this are Reels snippets, not something to cut a reel to. */
export const MIN_SOUND_MS = 15_000;

export type FoundMatch = { sound: InstagramAudioTrack; match: InstagramMatch };

/**
 * The best match for a candidate among search results: a recording before a
 * cover, then the surer match, then the longer sound. Snippets are skipped.
 */
export function bestInstagramMatch(candidate: { title: string; artist: string; isrc?: string | null }, sounds: InstagramAudioTrack[]): FoundMatch | null {
  let best: FoundMatch | null = null;
  for (const sound of sounds) {
    if (sound.durationMs !== null && sound.durationMs < MIN_SOUND_MS) continue;
    const match = matchInstagramSound(candidate, sound);
    if (!match) continue;
    if (!best || better({ sound, match }, best)) best = { sound, match };
  }
  return best;
}

function better(a: FoundMatch, b: FoundMatch): boolean {
  if (a.match.kind !== b.match.kind) return a.match.kind === "track";
  if (a.match.confidence !== b.match.confidence) return a.match.confidence > b.match.confidence;
  return (a.sound.durationMs ?? 0) > (b.sound.durationMs ?? 0);
}

export type AudioSearch = (type: InstagramAudioType, query: string) => Promise<InstagramAudioTrack[]>;

/**
 * Looks each candidate up in Instagram's library (music, then creators'
 * sounds for a cover) with `search`, which the caller supplies and paces.
 * A failed search is counted and skipped, never fatal.
 */
export async function matchCandidates<T extends { key: string; title: string; artist: string; isrc: string | null }>(
  candidates: T[],
  search: AudioSearch,
): Promise<{ matches: Map<string, FoundMatch>; searches: number; failures: number }> {
  const matches = new Map<string, FoundMatch>();
  let searches = 0;
  let failures = 0;
  for (const candidate of candidates) {
    for (const type of ["music", "original_sound"] as const) {
      const query = type === "music" ? `${candidate.title} ${normaliseArtist(candidate.artist)}` : candidate.title;
      searches++;
      let sounds: InstagramAudioTrack[];
      try {
        sounds = await search(type, query.slice(0, 100));
      } catch {
        failures++;
        continue;
      }
      const found = bestInstagramMatch(candidate, sounds);
      const known = matches.get(candidate.key);
      if (found && (!known || better(found, known))) matches.set(candidate.key, found);
      // A recording beats any cover: no need to look for one.
      if (found?.match.kind === "track") break;
    }
  }
  return { matches, searches, failures };
}

// ── Picking for a reel ──────────────────────────────────────────

/** A stored, matched candidate, as the editor's picks read it. */
export type PopularSoundRow = {
  key: string;
  title: string;
  artist: string;
  score: number;
  moods: MusicMoodId[];
  playlists: { name: string; followers: number }[];
  igAudioId: string;
  igAudioType: InstagramAudioType;
  igTitle: string;
  igArtist: string | null;
  igDurationMs: number | null;
  igMatch: MatchKind;
  /** 1-based rank in Instagram's trending list when last checked, or null. */
  trendingRank: number | null;
  bpm: number | null;
};

export type PopularPick = {
  /** Ready for the Music sheet's existing "edit to this sound" path. */
  track: InstagramAudioTrack;
  why: string;
  bpm: number | null;
  match: MatchKind;
};

/** 2_100_000 → "2.1M", 45_300 → "45K", 950 → "950". */
export function formatFollowers(count: number): string {
  const value = Math.max(0, Math.round(count));
  const short = (n: number, unit: string) => `${n >= 100 ? Math.round(n) : Number(n.toFixed(1))}${unit}`;
  if (value >= 1_000_000) return short(value / 1_000_000, "M");
  if (value >= 1_000) return short(value / 1_000, "K");
  return String(value);
}

/**
 * One line on why a sound is offered, from the stored data only:
 * "In 14 playlists like Cozy Winter Evenings, 2.1M followers".
 */
export function whyLine(row: Pick<PopularSoundRow, "playlists" | "igMatch" | "trendingRank">): string {
  const playlists = [...row.playlists].sort((a, b) => b.followers - a.followers);
  const total = playlists.reduce((sum, playlist) => sum + playlist.followers, 0);
  const top = playlists[0];
  let line = !top
    ? "Trending on Instagram"
    : playlists.length === 1
      ? `In ${top.name}, ${formatFollowers(top.followers)} followers`
      : `In ${playlists.length} playlists like ${top.name}, ${formatFollowers(total)} followers`;
  if (row.igMatch === "cover" && top) line = `Cover of a song ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
  if (top && row.trendingRank) line += ", trending on Instagram";
  return line;
}

/** Weight of a sound for the reel's first mood, its second, and any other. */
const MOOD_FIT = [1, 0.8] as const;
const OFF_MOOD = 0.35;
/** A sound that ends before the reel does plays the rest in silence on Instagram. */
const TOO_SHORT = 0.5;

/**
 * The sounds to offer for a reel: matched candidates for its moods, best
 * first, a sound shorter than the reel after one that is long enough, other
 * moods only to fill the row. Each Instagram sound once.
 */
export function pickPopularSounds(rows: PopularSoundRow[], input: { moods: MusicMoodId[]; reelMs: number; limit?: number }): PopularPick[] {
  const limit = input.limit ?? 5;
  const moods = input.moods.length > 0 ? input.moods.slice(0, 2) : [DEFAULT_MUSIC_MOOD];
  const ranked = rows
    .filter((row) => row.igAudioId && (row.igDurationMs === null || row.igDurationMs >= MIN_SOUND_MS))
    .map((row) => {
      const fit = moods.reduce((best, mood, index) => (row.moods.includes(mood) ? Math.max(best, MOOD_FIT[index] ?? OFF_MOOD) : best), OFF_MOOD);
      const length = row.igDurationMs !== null && input.reelMs > 0 && row.igDurationMs < input.reelMs ? TOO_SHORT : 1;
      return { row, onMood: fit > OFF_MOOD, weight: (row.score + trendingBonus(row.trendingRank)) * fit * length };
    })
    .sort((a, b) => Number(b.onMood) - Number(a.onMood) || b.weight - a.weight || a.row.key.localeCompare(b.row.key));

  const picks: PopularPick[] = [];
  const seen = new Set<string>();
  for (const { row } of ranked) {
    if (picks.length >= limit) break;
    if (seen.has(row.igAudioId)) continue;
    seen.add(row.igAudioId);
    picks.push({
      track: { id: row.igAudioId, type: row.igAudioType, title: row.igTitle, artist: row.igArtist, durationMs: row.igDurationMs, coverUrl: null, previewUrl: null },
      why: whyLine(row),
      bpm: row.bpm,
      match: row.igMatch,
    });
  }
  return picks;
}

/** The link to a sound's page on Instagram. */
export function instagramAudioLink(audioId: string): string {
  return `https://www.instagram.com/reels/audio/${encodeURIComponent(audioId)}/`;
}
