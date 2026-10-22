/**
 * The bodies of the Instagram Graph API content publishing calls (ADR 0065),
 * built here so they can be tested without a network. The web app's
 * Instagram client sends them:
 *
 *   POST /{ig-user-id}/media          a Reel or Story container
 *   GET  /{container-id}?fields=...   its processing status
 *   POST /{ig-user-id}/media_publish  publishes a FINISHED container
 *
 * Stories take a video or an image URL, `media_type=STORIES`, and the AI
 * disclosure. Instagram's docs mark `share_to_feed`, `audio_name` and
 * `cover_url` "for Reels only" and say stickers (links, polls, locations)
 * cannot be published through the API, so a story carries none of those,
 * and no caption.
 */
import { instagramAudioConfiguration } from "./instagram-audio";
import { INSTAGRAM } from "./instagram";

/** Where the Reel's cover frame is taken from when the reel has not chosen one (ADR 0017). */
export const DEFAULT_COVER_FRAME_MS = 700;

export type ReelContainerInput = {
  videoUrl: string;
  caption: string;
  coverMs?: number;
  /** A sound from Instagram's library (ADR 0018); volumes 0–100. */
  audio?: { audioId: string; audioVolume: number; videoVolume: number } | null;
  /** Instagram's self-disclosure of AI usage: the post gets an "AI info" label. */
  aiGenerated?: boolean;
};

/** The form body that creates a REELS container. */
export function reelContainerParams(input: ReelContainerInput): Record<string, string> {
  const params: Record<string, string> = {
    media_type: "REELS",
    video_url: input.videoUrl,
    caption: input.caption.slice(0, INSTAGRAM.captionMaxChars),
    share_to_feed: "true",
    thumb_offset: String(Math.max(0, Math.round(input.coverMs ?? DEFAULT_COVER_FRAME_MS))),
  };
  if (input.audio) params.audio_configuration = instagramAudioConfiguration(input.audio);
  if (input.aiGenerated) params.is_ai_generated = "true";
  return params;
}

export type StoryContainerInput = { videoUrl: string; imageUrl?: undefined; aiGenerated?: boolean } | { imageUrl: string; videoUrl?: undefined; aiGenerated?: boolean };

/** The form body that creates a STORIES container: the media, the type, the AI disclosure, nothing else. */
export function storyContainerParams(input: StoryContainerInput): Record<string, string> {
  const params: Record<string, string> = { media_type: "STORIES" };
  if (input.videoUrl) params.video_url = input.videoUrl;
  else if (input.imageUrl) params.image_url = input.imageUrl;
  else throw new Error("A story needs a video or an image URL.");
  if (input.aiGenerated) params.is_ai_generated = "true";
  return params;
}

/** The fields read from a container to learn where its processing stands. */
export const CONTAINER_STATUS_FIELDS = "status_code,status";

/** The form body of media_publish. */
export function publishParams(containerId: string): Record<string, string> {
  return { creation_id: containerId };
}

/** Whether a container id from the browser or the database looks like one Instagram issued. */
export function isContainerId(value: string): boolean {
  return /^\d{5,40}$/.test(value);
}
