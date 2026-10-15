/**
 * Instagram publishing through the Graph API. Needs a Meta app
 * (META_APP_ID, META_APP_SECRET) with Instagram content publishing, and an
 * Instagram professional account linked to a Facebook Page. Everything here
 * is plain fetch; tokens are stored on SocialAccount.
 *
 * Flow: Facebook Login -> long-lived user token -> the Page's
 * instagram_business_account -> create a REELS container from a public video
 * URL -> wait for processing -> publish.
 */

import {
  coverMs,
  instagramAudioConfiguration,
  parseInstagramAudioSearch,
  parseTimeline,
  type InstagramAudioTrack,
  type InstagramAudioType,
} from "@reelwalk/core";

/**
 * The Graph API version every call uses, and the Login dialog too. v22.0 is
 * the first with audio_configuration on Reels (ADR 0018).
 */
export const DEFAULT_GRAPH_VERSION = "v25.0";
const graphVersion = () => process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
const GRAPH = () => `https://graph.facebook.com/${graphVersion()}`;

export const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"];

/**
 * One-tap posting is offered only when the Meta app exists and is switched on
 * (INSTAGRAM_ENABLED=true). While the Meta app is in development mode only its
 * testers can connect, so the switch stays off for everyone else.
 */
export function isInstagramConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.INSTAGRAM_ENABLED === "true");
}

/**
 * The local stack's stand-in (DEV_FAKE_INSTAGRAM=true, docker-compose.yml):
 * /api/dev/instagram connects a pretend account so the end-to-end suite can
 * schedule and cancel posts without a Meta app. Nothing is ever sent to
 * Instagram with it, and a deployment with a real Meta app ignores the flag.
 */
export function isFakeInstagram(): boolean {
  return process.env.DEV_FAKE_INSTAGRAM === "true" && !isInstagramConfigured();
}

/**
 * Apps created with the Instagram use case get "Facebook Login for Business",
 * which takes a configuration id (META_LOGIN_CONFIG_ID, from the app's
 * Configurations page) instead of a scope list. Classic Facebook Login apps
 * leave it unset and send scopes.
 */
export function instagramAuthUrl(redirectUri: string, state: string): string {
  const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", process.env.META_APP_ID ?? "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (process.env.META_LOGIN_CONFIG_ID) {
    url.searchParams.set("config_id", process.env.META_LOGIN_CONFIG_ID);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
  }
  return url.toString();
}

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean } };

/**
 * Graph API error codes that clear up on their own: unknown or temporary
 * errors, rate limits, and "media not ready" / "could not fetch the video"
 * when Instagram's own fetch of the file has a hiccup.
 * https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 9004, 9007]);

/** An error answer from the Graph API, with what is needed to decide on a retry. */
export class InstagramError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly transient: boolean;

  constructor(message: string, status: number, code: number | null, transient: boolean) {
    super(message);
    this.name = "InstagramError";
    this.status = status;
    this.code = code;
    this.transient = transient;
  }
}

/** Whether a failed Graph call is worth retrying: Graph's own transient errors, 5xx, 429, and the network. */
export function isTransientInstagramError(error: unknown): boolean {
  if (error instanceof InstagramError) return error.transient;
  // fetch failures (DNS, a reset connection, the 20 s timeout) never got an answer from Instagram.
  return true;
}

async function graph<T>(path: string, init: RequestInit & { token?: string; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(`${GRAPH()}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  if (init.token) url.searchParams.set("access_token", init.token);
  const response = await fetch(url, { method: init.method ?? "GET", body: init.body, signal: AbortSignal.timeout(20_000) });
  const data = (await response.json().catch(() => ({}))) as T & GraphError;
  if (!response.ok || data.error) {
    const code = data.error?.code ?? null;
    const transient =
      response.status >= 500 || response.status === 429 || data.error?.is_transient === true || (code !== null && TRANSIENT_CODES.has(code));
    throw new InstagramError(data.error?.message ?? `Instagram answered ${response.status}.`, response.status, code, transient);
  }
  return data;
}

/** Trades the login code for a long-lived (about 60 days) user token. */
export async function exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const short = await graph<{ access_token: string }>("/oauth/access_token", {
    query: { client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, redirect_uri: redirectUri, code },
  });
  const long = await graph<{ access_token: string; expires_in?: number }>("/oauth/access_token", {
    query: {
      grant_type: "fb_exchange_token",
      client_id: process.env.META_APP_ID!,
      client_secret: process.env.META_APP_SECRET!,
      fb_exchange_token: short.access_token,
    },
  });
  return { accessToken: long.access_token, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null };
}

export type InstagramAccount = { id: string; username: string; pageName: string };

/** The Instagram professional accounts linked to the user's Pages. */
export async function listInstagramAccounts(token: string): Promise<InstagramAccount[]> {
  const pages = await graph<{ data: { name: string; instagram_business_account?: { id: string; username: string } }[] }>("/me/accounts", {
    token,
    query: { fields: "name,instagram_business_account{id,username}", limit: "50" },
  });
  return pages.data
    .filter((page) => page.instagram_business_account)
    .map((page) => ({ id: page.instagram_business_account!.id, username: page.instagram_business_account!.username, pageName: page.name }));
}

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

/**
 * Where the cover frame is taken from, in milliseconds. Frame 0 shows the
 * hero shot before any text overlay has faded in; by 700 ms the hook text has
 * finished its pop-in and the first clip's motion has barely started, so the
 * Explore, grid and feed tiles show the price line, not a blank room.
 */
export const COVER_FRAME_MS = 700;

/** The cover frame the reel chose (ADR 0023), or undefined for the usual one; a reel whose edit cannot be read gets the usual frame. */
export function reelCoverMs(timeline: unknown): number | undefined {
  try {
    return timeline ? coverMs(parseTimeline(timeline)) : undefined;
  } catch {
    return undefined;
  }
}

/** A sound from Instagram's library to mix in (ADR 0018); volumes are 0-100. */
export type ReelAudio = { audioId: string; audioVolume: number; videoVolume: number };

/** Step 1: asks Instagram to fetch the video and prepare a Reel. The URL must be reachable from the public internet. */
export async function createReelContainer(input: {
  igUserId: string;
  token: string;
  videoUrl: string;
  caption: string;
  coverMs?: number;
  audio?: ReelAudio | null;
}): Promise<string> {
  const body = new URLSearchParams({
    media_type: "REELS",
    video_url: input.videoUrl,
    caption: input.caption.slice(0, 2200),
    share_to_feed: "true",
    thumb_offset: String(Math.max(0, Math.round(input.coverMs ?? COVER_FRAME_MS))),
  });
  if (input.audio) body.set("audio_configuration", instagramAudioConfiguration(input.audio));
  const result = await graph<{ id: string }>(`/${input.igUserId}/media`, { method: "POST", body, token: input.token });
  return result.id;
}

/** Step 2: processing takes from a few seconds to a few minutes. */
export async function containerStatus(containerId: string, token: string): Promise<{ status: ContainerStatus; detail: string | null }> {
  const result = await graph<{ status_code: ContainerStatus; status?: string }>(`/${containerId}`, { token, query: { fields: "status_code,status" } });
  return { status: result.status_code, detail: result.status ?? null };
}

/** Step 3: publishes a FINISHED container and returns the post's permalink. */
export async function publishContainer(igUserId: string, containerId: string, token: string): Promise<{ mediaId: string; permalink: string | null }> {
  const body = new URLSearchParams({ creation_id: containerId });
  const published = await graph<{ id: string }>(`/${igUserId}/media_publish`, { method: "POST", body, token });
  const media = await graph<{ permalink?: string }>(`/${published.id}`, { token, query: { fields: "permalink" } }).catch(() => ({ permalink: undefined }));
  return { mediaId: published.id, permalink: media.permalink ?? null };
}

/**
 * Searches Instagram's audio library (GET /ig_audio). An empty query returns
 * what is trending. For a business account `music` is the commercially
 * cleared catalogue; `original_sound` is creators' sounds. At most 25, no
 * paging.
 */
export async function fetchInstagramAudio(input: { igUserId: string; token: string; type: InstagramAudioType; query: string }): Promise<InstagramAudioTrack[]> {
  const query: Record<string, string> = { audio_type: input.type, user_id: input.igUserId };
  if (input.query.trim()) query.search_query = input.query.trim();
  const body = await graph<{ audio?: unknown }>("/ig_audio", { token: input.token, query });
  return parseInstagramAudioSearch(body, input.type);
}

/** One sound by id (GET /{audio-id}), shaped like a search result; empty when Instagram does not share it with this account. */
export async function fetchInstagramAudioById(input: { igUserId: string; token: string; id: string; type: InstagramAudioType }): Promise<InstagramAudioTrack[]> {
  const body = await graph<Record<string, unknown>>(`/${input.id}`, { token: input.token, query: { user_id: input.igUserId } });
  return parseInstagramAudioSearch({ audio: [{ audio_id: input.id, ...body }] }, input.type);
}

/** Graph error codes meaning the login no longer works, and ones meaning a permission is missing. */
const EXPIRED_TOKEN_CODES = new Set([102, 190, 463, 467]);
const PERMISSION_CODES = new Set([3, 10]);

/** A Graph API failure in words a studio can act on. */
export function instagramErrorMessage(error: unknown, fallback = "Instagram did not answer. Try again in a moment."): string {
  if (error instanceof InstagramError) {
    if (error.code !== null && EXPIRED_TOKEN_CODES.has(error.code)) return "Your Instagram connection has expired. Reconnect it on the Account tab.";
    // 200-299 are the "permission denied" family.
    if (error.code !== null && (PERMISSION_CODES.has(error.code) || (error.code >= 200 && error.code < 300))) {
      return "ReelWalk is missing an Instagram permission for this. Reconnect Instagram on the Account tab and allow everything it asks for.";
    }
    return error.transient ? fallback : error.message;
  }
  return fallback;
}

/**
 * Comments on the account's most recent posts, read with the publishing
 * (Facebook Login) token: one request. Used by keyword comment replies (ADR
 * 0026) because the Instagram Login token sees only comments by people with
 * a role on the app while the Meta app is unpublished; this one sees them
 * all. The commenter's username may be missing.
 */
export async function recentPostComments(
  igUserId: string,
  token: string,
  posts = 10,
  perPost = 50,
): Promise<{ id: string; mediaId: string; text: string; timestamp: string; username: string | null }[]> {
  type Comment = { id: string; text?: string; timestamp: string; username?: string };
  const data = await graph<{ data: { id: string; comments?: { data: Comment[] } }[] }>(`/${igUserId}/media`, {
    token,
    query: { fields: `id,comments.limit(${perPost}){id,text,timestamp,username}`, limit: String(posts) },
  });
  return data.data.flatMap((media) =>
    (media.comments?.data ?? []).map((c) => ({ id: c.id, mediaId: media.id, text: c.text ?? "", timestamp: c.timestamp, username: c.username ?? null })),
  );
}
