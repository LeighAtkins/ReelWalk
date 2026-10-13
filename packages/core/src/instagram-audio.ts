import { z } from "zod";

/**
 * Instagram's own licensed audio (ADR 0018). A Reel can be published with a
 * track or sound from Instagram's library attached: search it with
 * GET /ig_audio, then pass `audio_configuration` when the media container is
 * created. Instagram mixes the sound in on its side, so the export itself is
 * never changed.
 * https://developers.facebook.com/docs/instagram-platform/content-publishing/audio-api/
 */

/** `music` is the commercially cleared catalogue for business accounts; `original_sound` is creators' sounds, trending first. */
export const INSTAGRAM_AUDIO_TYPES = ["music", "original_sound"] as const;
export type InstagramAudioType = (typeof INSTAGRAM_AUDIO_TYPES)[number];

export function isInstagramAudioType(value: unknown): value is InstagramAudioType {
  return typeof value === "string" && (INSTAGRAM_AUDIO_TYPES as readonly string[]).includes(value);
}

/** One search result, as the picker shows it. */
export type InstagramAudioTrack = {
  id: string;
  type: InstagramAudioType;
  title: string;
  /** The artist for music, "@handle" for an original sound. */
  artist: string | null;
  durationMs: number | null;
  coverUrl: string | null;
  /** A temporary (about a day and a half) link to the sound alone, for previewing. */
  previewUrl: string | null;
};

/** Longest search text sent to Instagram. */
export const INSTAGRAM_AUDIO_QUERY_MAX = 100;

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Cover and preview links: https only (the page's CSP and mixed content), dropped when anything else. */
const httpsUrl = z.string().refine(isHttps).nullish().catch(null);

const audioItemSchema = z.object({
  audio_id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().nullish(),
  display_artist: z.string().nullish(),
  ig_username: z.string().nullish(),
  duration_in_ms: z.number().nullish().catch(null),
  cover_artwork_thumbnail_uri: httpsUrl,
  download_url: httpsUrl,
  audio_type: z.string().nullish(),
});

/**
 * A pasted Instagram audio page (instagram.com/reels/audio/<id>/, also the
 * /reel/audio and app share forms) or a bare numeric id: the sound's id, so a
 * trend spotted on Instagram can be used even when search does not list it.
 */
export function instagramAudioIdFromQuery(query: string): string | null {
  const text = query.trim();
  const link = text.match(/instagram\.com\/(?:reels?\/)?audio\/(\d{6,25})/i);
  if (link) return link[1]!;
  return /^\d{10,25}$/.test(text) ? text : null;
}

/**
 * Reads GET /ig_audio's answer. The list is under `audio` (not `data`, as
 * almost everywhere else in the Graph API). Items Instagram sends malformed
 * are skipped rather than failing the whole search.
 */
export function parseInstagramAudioSearch(body: unknown, requested: InstagramAudioType): InstagramAudioTrack[] {
  const list = body && typeof body === "object" && Array.isArray((body as { audio?: unknown }).audio) ? (body as { audio: unknown[] }).audio : [];
  const tracks: InstagramAudioTrack[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const parsed = audioItemSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.audio_id || seen.has(parsed.data.audio_id)) continue;
    const item = parsed.data;
    seen.add(item.audio_id);
    const type = isInstagramAudioType(item.audio_type) ? item.audio_type : requested;
    const handle = item.ig_username ? `@${item.ig_username.replace(/^@/, "")}` : null;
    const artist = type === "music" ? (item.display_artist ?? handle) : (handle ?? item.display_artist);
    tracks.push({
      id: item.audio_id,
      type,
      title: item.title?.trim() || (type === "music" ? "Untitled track" : "Original audio"),
      artist: artist?.trim() || null,
      durationMs: item.duration_in_ms && item.duration_in_ms > 0 ? Math.round(item.duration_in_ms) : null,
      coverUrl: item.cover_artwork_thumbnail_uri ?? null,
      previewUrl: item.download_url ?? null,
    });
  }
  return tracks;
}

/**
 * How the chosen sound is mixed with the reel's own soundtrack. By default
 * the sound replaces it; "keep my reel's own music" leaves it underneath at
 * about a third.
 */
export const INSTAGRAM_AUDIO_MIX = {
  replace: { audioVolume: 100, videoVolume: 0 },
  underlay: { audioVolume: 100, videoVolume: 35 },
} as const;

export function instagramAudioMix(keepReelAudio: boolean): { audioVolume: number; videoVolume: number } {
  return { ...(keepReelAudio ? INSTAGRAM_AUDIO_MIX.underlay : INSTAGRAM_AUDIO_MIX.replace) };
}

/** A sound picked for a post: what is stored on a scheduled post and sent with a post-now. */
export const instagramAudioChoiceSchema = z.object({
  audioId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Unknown sound."),
  title: z.string().trim().min(1).max(200),
  artist: z.string().trim().max(200).nullish().transform((value) => value || null),
  audioVolume: z.number().int().min(0).max(100),
  videoVolume: z.number().int().min(0).max(100),
});
export type InstagramAudioChoice = z.infer<typeof instagramAudioChoiceSchema>;

/** Validates a choice from the browser; null when there is none or it is malformed. */
export function parseInstagramAudioChoice(value: unknown): InstagramAudioChoice | null {
  if (value === null || value === undefined) return null;
  const parsed = instagramAudioChoiceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A sound's name in one line: "Title · Artist". */
export function instagramAudioLabel(choice: { title: string; artist?: string | null }): string {
  return choice.artist ? `${choice.title} · ${choice.artist}` : choice.title;
}

const clampVolume = (value: number) => Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));

/**
 * The `audio_configuration` field of POST /{ig-user-id}/media (Graph API
 * v22.0 and later): a JSON string with the sound and both volumes, 0-100.
 */
export function instagramAudioConfiguration(choice: { audioId: string; audioVolume: number; videoVolume: number }): string {
  return JSON.stringify({ audio_id: choice.audioId, audio_volume: clampVolume(choice.audioVolume), video_volume: clampVolume(choice.videoVolume) });
}

/** What the local stack's pretend Instagram (DEV_FAKE_INSTAGRAM) offers. Nothing here is a real sound. */
export const FAKE_INSTAGRAM_AUDIO: readonly InstagramAudioTrack[] = [
  { id: "fake-music-1", type: "music", title: "Open House Morning", artist: "ReelWalk Test Band", durationMs: 92_000, coverUrl: null, previewUrl: null },
  { id: "fake-music-2", type: "music", title: "Sunlit Kitchen", artist: "The Floor Plans", durationMs: 75_000, coverUrl: null, previewUrl: null },
  { id: "fake-music-3", type: "music", title: "Key Handover", artist: "Escrow", durationMs: 61_000, coverUrl: null, previewUrl: null },
  { id: "fake-sound-1", type: "original_sound", title: "Original audio", artist: "@reelwalk.test", durationMs: 15_000, coverUrl: null, previewUrl: null },
  { id: "fake-sound-2", type: "original_sound", title: "Just listed (remix)", artist: "@agent.demo", durationMs: 22_000, coverUrl: null, previewUrl: null },
];

/** The pretend search: trending is everything of the type; a query matches title or artist. */
export function searchFakeInstagramAudio(type: InstagramAudioType, query: string): InstagramAudioTrack[] {
  const needle = query.trim().toLowerCase();
  return FAKE_INSTAGRAM_AUDIO.filter(
    (track) => track.type === type && (!needle || track.title.toLowerCase().includes(needle) || (track.artist ?? "").toLowerCase().includes(needle)),
  );
}
