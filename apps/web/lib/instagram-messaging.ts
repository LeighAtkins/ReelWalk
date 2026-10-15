/**
 * The Instagram API with Instagram Login (ADR 0026), used only for keyword
 * comment replies: reading comments on the account's recent posts and
 * sending one private reply per comment. Publishing stays on the Facebook
 * Login flow in instagram.ts. Needs the Instagram app id and secret from the
 * Meta app's "API setup with Instagram login" page (INSTAGRAM_APP_ID,
 * INSTAGRAM_APP_SECRET); the token lasts 60 days and is refreshed here.
 */

import { InstagramError, isTransientInstagramError } from "./instagram";

export { isTransientInstagramError };

export const MESSAGING_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
  // Views, reach and watch time on the Scheduled page (ADR 0027).
  "instagram_business_manage_insights",
];

const version = () => process.env.META_GRAPH_VERSION || "v25.0";
const IG_GRAPH = () => `https://graph.instagram.com/${version()}`;

// Terraform stores an absent value as "unset" (Parameter Store refuses empty values).
const present = (value: string | undefined) => Boolean(value && value !== "unset");

export function isMessagingConfigured(): boolean {
  return present(process.env.INSTAGRAM_APP_ID) && present(process.env.INSTAGRAM_APP_SECRET);
}

/** Instagram's own login dialog, asking for comments and messages. */
export function messagingAuthUrl(redirectUri: string, state: string): string {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", process.env.INSTAGRAM_APP_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", MESSAGING_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

type IgError = { error?: { message?: string; code?: number; is_transient?: boolean }; error_message?: string; code?: number };
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

async function call<T>(url: URL, init: { method?: string; token?: string; json?: unknown; form?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  const response = await fetch(url, { method: init.method ?? "GET", headers, body, signal: AbortSignal.timeout(20_000) });
  const data = (await response.json().catch(() => ({}))) as T & IgError;
  if (!response.ok || data.error || data.error_message) {
    const code = data.error?.code ?? data.code ?? null;
    const transient = response.status >= 500 || response.status === 429 || data.error?.is_transient === true || (code !== null && TRANSIENT_CODES.has(code));
    throw new InstagramError(data.error?.message ?? data.error_message ?? `Instagram answered ${response.status}.`, response.status, code, transient);
  }
  return data;
}

/** Trades the login code for a long-lived token, and reads which account it is. */
export async function exchangeMessagingCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; expiresAt: Date | null; userId: string; username: string }> {
  const short = await call<{ access_token?: string; data?: { access_token: string }[] }>(new URL("https://api.instagram.com/oauth/access_token"), {
    method: "POST",
    form: {
      client_id: process.env.INSTAGRAM_APP_ID!,
      client_secret: process.env.INSTAGRAM_APP_SECRET!,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    },
  });
  const shortToken = short.access_token ?? short.data?.[0]?.access_token;
  if (!shortToken) throw new InstagramError("Instagram did not return a token.", 200, null, false);
  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", process.env.INSTAGRAM_APP_SECRET!);
  longUrl.searchParams.set("access_token", shortToken);
  const long = await call<{ access_token: string; expires_in?: number }>(longUrl);
  const me = await messagingAccount(long.access_token);
  return {
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
    userId: me.userId,
    username: me.username,
  };
}

export async function messagingAccount(token: string): Promise<{ userId: string; username: string }> {
  const url = new URL(`${IG_GRAPH()}/me`);
  url.searchParams.set("fields", "user_id,username");
  const me = await call<{ id: string; user_id?: string; username: string }>(url, { token });
  return { userId: me.user_id ?? me.id, username: me.username };
}

/** A fresh 60-day token from one that is at least a day old and still valid. */
export async function refreshMessagingToken(token: string): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const data = await call<{ access_token: string; expires_in?: number }>(url);
  return { accessToken: data.access_token, expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null };
}

export type RecentComment = { id: string; mediaId: string; text: string; timestamp: string; username: string | null };

/** Comments on the account's most recent posts, newest posts first: one request. */
export async function recentComments(token: string, posts = 10, perPost = 50): Promise<RecentComment[]> {
  const url = new URL(`${IG_GRAPH()}/me/media`);
  url.searchParams.set("fields", `id,timestamp,comments.limit(${perPost}){id,text,timestamp,username,from}`);
  url.searchParams.set("limit", String(posts));
  type Comment = { id: string; text?: string; timestamp: string; username?: string; from?: { username?: string } };
  const data = await call<{ data: { id: string; comments?: { data: Comment[] } }[] }>(url, { token });
  return data.data.flatMap((media) =>
    (media.comments?.data ?? []).map((c) => ({
      id: c.id,
      mediaId: media.id,
      text: c.text ?? "",
      timestamp: c.timestamp,
      username: c.username ?? c.from?.username ?? null,
    })),
  );
}

/** The one private reply Instagram allows per comment. */
export async function sendPrivateReply(token: string, commentId: string, text: string): Promise<void> {
  await call(new URL(`${IG_GRAPH()}/me/messages`), { method: "POST", token, json: { recipient: { comment_id: commentId }, message: { text } } });
}

/** A public answer under the comment ("Sent you a DM"). */
export async function replyToComment(token: string, commentId: string, text: string): Promise<void> {
  const url = new URL(`${IG_GRAPH()}/${commentId}/replies`);
  await call(url, { method: "POST", token, form: { message: text } });
}

export type PostInsights = {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  /** Milliseconds. */
  avgWatchMs: number | null;
};

const INSIGHT_METRICS = ["views", "reach", "likes", "comments", "saved", "shares", "ig_reels_avg_watch_time"];

/**
 * A published reel's numbers (ADR 0027). "permission" when the connection
 * predates the insights permission and needs a reconnect; null when Instagram
 * has nothing yet or the call failed.
 */
export async function postInsights(token: string, mediaId: string): Promise<PostInsights | "permission" | null> {
  const url = new URL(`${IG_GRAPH()}/${mediaId}/insights`);
  url.searchParams.set("metric", INSIGHT_METRICS.join(","));
  try {
    const data = await call<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(url, { token });
    const value = (name: string) => {
      const row = data.data.find((d) => d.name === name);
      const v = row?.values?.[0]?.value ?? row?.total_value?.value;
      return typeof v === "number" ? v : null;
    };
    return {
      views: value("views"),
      reach: value("reach"),
      likes: value("likes"),
      comments: value("comments"),
      saved: value("saved"),
      shares: value("shares"),
      avgWatchMs: value("ig_reels_avg_watch_time"),
    };
  } catch (error) {
    if (error instanceof InstagramError && error.code === 10) return "permission";
    console.warn("instagram: insights failed", mediaId, error);
    return null;
  }
}
