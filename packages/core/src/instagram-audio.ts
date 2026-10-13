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

/**
 * Search words for Instagram's business music library that return good
 * listing music, tested against the library on 2026-10-13: its search
 * matches titles more than moods, so these are the words that do work.
 * The empty query is Instagram's own popular list for business accounts.
 * `mood` is what the model is told the results are good for.
 */
export const INSTAGRAM_MUSIC_SUGGESTIONS: { label: string; query: string; mood: string }[] = [
  { label: "Popular", query: "", mood: "popular with business accounts right now" },
  { label: "Real estate", query: "real estate", mood: "made for home and listing videos" },
  { label: "Luxury", query: "luxury", mood: "luxury, polished" },
  { label: "Soft house", query: "soft house", mood: "soft house, warm and steady" },
  { label: "Nu disco", query: "nu disco", mood: "nu disco, bright and fun" },
  { label: "Upbeat house", query: "upbeat house", mood: "upbeat house, energetic" },
  { label: "Piano", query: "piano", mood: "piano, calm and elegant" },
  { label: "Relaxing", query: "relaxing", mood: "relaxing, calm" },
  { label: "Lo-fi", query: "lofi", mood: "lo-fi, laid back" },
  { label: "Aesthetic", query: "aesthetic", mood: "aesthetic, soft and dreamy" },
];

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

// ── Editing against an Instagram sound (ADR 0019) ──────────────

/** Longest preview file ReelWalk keeps a private copy of. Instagram's previews are a few megabytes. */
export const INSTAGRAM_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** Extension and content type to store a preview under; anything unrecognised is treated as MP4 audio. */
export function instagramPreviewFormat(contentType: string | null | undefined): { extension: string; contentType: string } {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "audio/mpeg" || type === "audio/mp3") return { extension: "mp3", contentType: "audio/mpeg" };
  if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return { extension: "wav", contentType: "audio/wav" };
  if (type === "audio/aac") return { extension: "aac", contentType: "audio/aac" };
  // Instagram serves its previews as MP4 (sometimes labelled video/mp4) holding only an audio track.
  return { extension: "m4a", contentType: "audio/mp4" };
}

/** Object key of a workspace's private copy of a sound's preview. */
export function instagramPreviewKeyFor(workspaceId: string, audioId: string, extension: string): string {
  const safe = audioId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "sound";
  return `uploads/${workspaceId}/instagram-audio/${safe}.${extension}`;
}

/** The export screen's choice for a reel edited to an Instagram sound: replace the reel's soundtrack, as by default. */
export function instagramChoiceForSound(sound: { audioId: string; title: string; artist: string | null }): InstagramAudioChoice {
  return { audioId: sound.audioId, title: sound.title, artist: sound.artist, ...instagramAudioMix(false) };
}

/**
 * How far the sound may drift from the video in "Play with sound" before it
 * is pulled back, in seconds. Below about 80 ms nobody hears it; seeking the
 * audio more often than needed makes it stutter.
 */
export const SOUND_SYNC_TOLERANCE_S = 0.08;

/**
 * Where the sound should jump to so it plays in step with the video, or null
 * when it is close enough, or when the video is past the sound's end (the
 * reel then plays on in silence, as on Instagram with a shorter sound).
 */
export function soundSyncTarget(videoS: number, soundS: number, soundDurationS: number | null, toleranceS = SOUND_SYNC_TOLERANCE_S): number | null {
  if (!Number.isFinite(videoS) || videoS < 0) return null;
  if (soundDurationS !== null && Number.isFinite(soundDurationS) && videoS >= soundDurationS) return null;
  return Math.abs(videoS - soundS) > toleranceS ? videoS : null;
}

/**
 * The local stack's pretend Instagram sound (DEV_FAKE_INSTAGRAM): clicks at
 * 120 bpm, first beat at 250 ms, made on the fly so the end-to-end suite has
 * something to download, play and find the tempo of without Instagram.
 * 8-bit mono WAV at 11,025 Hz keeps it to about 130 KB.
 */
export const FAKE_INSTAGRAM_SOUND = { bpm: 120, offsetMs: 250, seconds: 12, sampleRate: 11_025 } as const;

export function fakeInstagramSoundWav(): Uint8Array {
  const { bpm, offsetMs, seconds, sampleRate } = FAKE_INSTAGRAM_SOUND;
  const count = sampleRate * seconds;
  const samples = new Float32Array(count);
  const period = (60 / bpm) * sampleRate;
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let beat = (offsetMs / 1000) * sampleRate; beat < count; beat += period) {
    // A short burst of noise over a tone: a click both a detector and an ear can find.
    for (let i = 0; i < 400 && beat + i < count; i++) {
      const fade = 1 - i / 400;
      samples[Math.floor(beat) + i] = (noise() * 0.6 + Math.sin((2 * Math.PI * 880 * i) / sampleRate) * 0.4) * fade;
    }
  }
  const bytes = new Uint8Array(44 + count);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + count, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // bytes per second: one byte per sample
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, count, true);
  for (let i = 0; i < count; i++) bytes[44 + i] = Math.max(0, Math.min(255, Math.round(128 + samples[i]! * 127)));
  return bytes;
}
