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

const GRAPH = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION ?? "v21.0"}`;

export const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"];

export function isInstagramConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

/**
 * Apps created with the Instagram use case get "Facebook Login for Business",
 * which takes a configuration id (META_LOGIN_CONFIG_ID, from the app's
 * Configurations page) instead of a scope list. Classic Facebook Login apps
 * leave it unset and send scopes.
 */
export function instagramAuthUrl(redirectUri: string, state: string): string {
  const url = new URL(`https://www.facebook.com/${process.env.META_GRAPH_VERSION ?? "v21.0"}/dialog/oauth`);
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

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number } };

async function graph<T>(path: string, init: RequestInit & { token?: string; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(`${GRAPH()}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  if (init.token) url.searchParams.set("access_token", init.token);
  const response = await fetch(url, { method: init.method ?? "GET", body: init.body, signal: AbortSignal.timeout(20_000) });
  const data = (await response.json().catch(() => ({}))) as T & GraphError;
  if (!response.ok || data.error) throw new Error(data.error?.message ?? `Instagram answered ${response.status}.`);
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

/** Step 1: asks Instagram to fetch the video and prepare a Reel. The URL must be reachable from the public internet. */
export async function createReelContainer(input: { igUserId: string; token: string; videoUrl: string; caption: string }): Promise<string> {
  const body = new URLSearchParams({ media_type: "REELS", video_url: input.videoUrl, caption: input.caption.slice(0, 2200), share_to_feed: "true" });
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
