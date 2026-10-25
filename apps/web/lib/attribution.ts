/**
 * Where a sign-up came from (ADR 0080). An ad or a link carries utm_* and a
 * click id (gclid, fbclid) in its query string; the marketing pages pass them
 * on in their own links, the sign-up form carries them in hidden fields, and
 * the server stores them with the new user. Nothing is kept in a cookie or in
 * browser storage, so there is nothing to ask consent for: the parameters
 * live in the URL the visitor already followed.
 */

/** The only keys read from a URL. Anything else in the query string is ignored. */
export const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "ttclid",
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];
export type Attribution = Partial<Record<AttributionKey, string>>;

const MAX_VALUE = 200;

type ParamSource = URLSearchParams | FormData | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | undefined {
  if (source instanceof URLSearchParams || source instanceof FormData) {
    const value = source.get(key);
    return typeof value === "string" ? value : undefined;
  }
  const value = source[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Printable characters only, trimmed and capped: this ends up in a database row and in our own links. */
function clean(value: string | undefined): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_VALUE);
  return text.length > 0 ? text : null;
}

/** The attribution parameters present in a query string, a form or a Next `searchParams` object; null when there are none. */
export function pickAttribution(source: ParamSource): Attribution | null {
  const found: Attribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = clean(read(source, key));
    if (value) found[key] = value;
  }
  return Object.keys(found).length > 0 ? found : null;
}

/** `href` with the attribution appended to its query string, so the next page sees it too. */
export function withAttribution(href: string, attribution: Attribution | null): string {
  if (!attribution) return href;
  const hash = href.indexOf("#");
  const path = hash === -1 ? href : href.slice(0, hash);
  const fragment = hash === -1 ? "" : href.slice(hash);
  const params = new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");
  for (const key of ATTRIBUTION_KEYS) {
    const value = attribution[key];
    if (value && !params.has(key)) params.set(key, value);
  }
  const base = path.includes("?") ? path.slice(0, path.indexOf("?")) : path;
  return `${base}?${params.toString()}${fragment}`;
}

/** Reads back what `pickAttribution` stored (a JSON column), dropping anything unexpected. */
export function readAttribution(value: unknown): Attribution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return pickAttribution(value as Record<string, string | undefined>);
}
