import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The pure parts of the connector's OAuth 2.1 server (ADR 0077): token
 * making and hashing, PKCE, redirect-URI rules. Nothing here touches the
 * database or the request, so the rules are tested on their own.
 */

export const CODE_TTL_MS = 5 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 3600_000;

export type TokenPrefix = "rwa" | "rwr" | "rwc";

/** A random secret with a recognisable prefix (access, refresh, code), so a leaked one is easy to spot and to scan for. */
export function newSecret(prefix: TokenPrefix): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Only this is stored: a database read-out does not hand out working tokens. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A client_id for a newly registered app. */
export const newClientId = (): string => `rwc_${randomBytes(18).toString("base64url")}`;

// ── PKCE (RFC 7636), S256 only ───────────────────────────────────

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export const isCodeChallenge = (value: string | null | undefined): value is string => typeof value === "string" && CHALLENGE.test(value);

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** True when `verifier` is a well-formed code verifier that hashes to `challenge`. */
export function verifyPkce(verifier: string | null | undefined, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER.test(verifier)) return false;
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(challengeFor(verifier));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── Redirect URIs ────────────────────────────────────────────────

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"]);

/**
 * Whether an app may register this redirect URI: https anywhere, plain http
 * only on the loopback interface (a desktop app's own listener), or a custom
 * scheme (a native app's own, such as `cursor:`). No fragments, no credentials.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** Exact match against the registered list; a loopback address may differ in port only (RFC 8252). */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:" || !LOOPBACK.has(want.hostname)) return false;
  return registered.some((uri) => {
    try {
      const have = new URL(uri);
      return have.protocol === "http:" && have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search;
    } catch {
      return false;
    }
  });
}

/** `base` with the query parameters added (an authorization response). */
export function withParams(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

// ── The resource this server protects ────────────────────────────

/** The canonical MCP resource URL for a site origin (RFC 8707): `https://host/mcp`, no trailing slash. */
export const resourceFor = (origin: string): string => `${origin.replace(/\/+$/, "")}/mcp`;

/** Whether a client's `resource` parameter names this server's MCP endpoint (a trailing slash is tolerated). */
export const isOurResource = (value: string | null | undefined, origin: string): boolean => value === undefined || value === null || value === "" || value.replace(/\/+$/, "") === resourceFor(origin);
