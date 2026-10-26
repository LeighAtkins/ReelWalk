/**
 * Where a sign-up came from (ADR 0080). An ad or a link carries utm_* and a
 * click id (gclid, fbclid) in its query string; the marketing pages pass them
 * on in their own links, the sign-up form carries them in hidden fields, and
 * the server stores them with the new user. Nothing is kept in a cookie or in
 * browser storage, so there is nothing to ask consent for: the parameters
 * live in the URL the visitor already followed.
 *
 * The plan a visitor picked on the pricing page ("Start free, then Agent",
 * ADR 0081) travels the same way as intent_plan / intent_interval, so it is
 * stored with the user and copied onto their funnel events without a new
 * column. Reading it back is `planIntentOf`.
 */
import { isBillingInterval, type BillingInterval, type PlanId } from "@reelwalk/core";

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
  "intent_plan",
  "intent_interval",
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

/** What a plan name in a link means: the paid plans, by id or by the name the pricing page shows. */
const INTENT_PLANS: Record<string, Exclude<PlanId, "FREE">> = { agent: "AGENT", office: "OFFICE", studio: "OFFICE" };

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
    if (!value) continue;
    // The plan intent is not free text: only a paid plan and a real interval are kept, in their canonical form.
    if (key === "intent_plan") {
      const plan = INTENT_PLANS[value.toLowerCase()];
      if (plan) found[key] = plan;
    } else if (key === "intent_interval") {
      const interval = value.toLowerCase();
      if (isBillingInterval(interval)) found[key] = interval;
    } else {
      found[key] = value;
    }
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

/** The paid plan a visitor picked before signing up, if any; the interval defaults to monthly. */
export function planIntentOf(attribution: Attribution | null): { plan: Exclude<PlanId, "FREE">; interval: BillingInterval } | null {
  const plan = attribution?.intent_plan;
  if (plan !== "AGENT" && plan !== "OFFICE") return null;
  const interval = attribution?.intent_interval;
  return { plan, interval: interval && isBillingInterval(interval) ? interval : "month" };
}

/** A sign-up link that remembers which paid plan was picked (and the ad parameters, as before). */
export function signupHrefFor(plan: PlanId, interval: BillingInterval, attribution: Attribution | null): string {
  if (plan === "FREE") return withAttribution("/signup", attribution);
  return withAttribution(`/signup?intent_plan=${plan}&intent_interval=${interval}`, attribution);
}
