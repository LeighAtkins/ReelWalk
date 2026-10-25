import { countAttempt, overLimit, type Limit } from "../throttle";

/**
 * Small request helpers shared by the connector's endpoints (ADR 0077): the
 * site's own origin, the caller's address, a body read with a size cap, CORS,
 * and the per-key request limits.
 */

/** The origin this app is reached on: APP_URL when set, else what the proxy reported for this request. */
export function siteOrigin(request: Request): string {
  const configured = process.env.APP_URL;
  if (configured) return new URL(configured).origin;
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** The caller's address, as the proxy in front of the app reports it. */
export function requestIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** The body as text, or null when it is larger than `maxBytes` (checked on the header and again while reading). */
export async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The connector is called by other apps' servers and by browser-based
 * clients such as the MCP inspector. It authenticates with bearer tokens, not
 * cookies, so any origin may call it without being able to act as a signed-in
 * browser.
 */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Retry-After",
  "Access-Control-Max-Age": "86400",
} as const;

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS_HEADERS });

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store", ...headers } });
}

/** Counts one request against each limit and says whether it may go ahead. */
export async function allow(limits: Limit[]): Promise<boolean> {
  if (await overLimit(limits)) return false;
  await countAttempt(limits);
  return true;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** Retry-After for a fixed window limit: the longest window is the honest upper bound. */
export const retryAfterSeconds = (limits: Limit[]): string => String(Math.ceil(Math.max(...limits.map((limit) => limit.windowMs)) / 1000));
