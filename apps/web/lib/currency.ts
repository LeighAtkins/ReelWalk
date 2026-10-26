import { isCurrency, type Currency } from "@reelwalk/core";

/**
 * Which currency a visitor sees and pays in (ADR 0085): A$ (GST included) for
 * Australia, US$ (plus tax) for everyone else. The evidence, strongest first:
 *
 * 1. `rw_currency`: the visitor picked a currency on the pricing page's toggle.
 * 2. A country header from a CDN in front of the site (`CF-IPCountry`,
 *    `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`). The site runs on App
 *    Runner behind envoy, which sets none of them, so this is usually absent.
 * 3. `rw_country`: written by `COUNTRY_SNIPPET` in the browser from the time
 *    zone (Australia/*) and the languages (en-AU). "AU" or "ZZ" (elsewhere).
 * 4. Nothing: US$, with `source: "default"`, so the page can let the snippet
 *    correct the shown prices before they paint (see `CurrencyScope`).
 *
 * Nothing here is trusted for money: checkout charges whatever price the
 * resolved currency names, and either is a real, correct price.
 */
export const CURRENCY_COOKIE = "rw_currency";
export const COUNTRY_COOKIE = "rw_country";

const COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-country-code"];

export type CurrencySource = "choice" | "header" | "cookie" | "default";
export type CurrencyResolution = { currency: Currency; source: CurrencySource; country: string | null };

export type CurrencyEvidence = {
  header: (name: string) => string | null | undefined;
  cookie: (name: string) => string | null | undefined;
};

/** An ISO country code a CDN or the snippet would send; "XX" and "T1" (Cloudflare's unknown and Tor) are not. */
function country(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) && code !== "XX" ? code : null;
}

export function currencyForCountry(code: string | null): Currency {
  return code === "AU" ? "aud" : "usd";
}

export function resolveCurrency(evidence: CurrencyEvidence): CurrencyResolution {
  const chosen = evidence.cookie(CURRENCY_COOKIE);
  const fromHeader = COUNTRY_HEADERS.map((name) => country(evidence.header(name))).find(Boolean) ?? null;
  const fromCookie = country(evidence.cookie(COUNTRY_COOKIE));
  const known = fromHeader ?? fromCookie;
  if (isCurrency(chosen)) return { currency: chosen, source: "choice", country: known };
  if (fromHeader) return { currency: currencyForCountry(fromHeader), source: "header", country: fromHeader };
  if (fromCookie) return { currency: currencyForCountry(fromCookie), source: "cookie", country: fromCookie };
  return { currency: "usd", source: "default", country: null };
}

/**
 * Plain browser JavaScript, inlined in the root layout and in `CurrencyScope`: writes `rw_country` once
 * (a year, the whole site) from the time zone and languages, and, inside a scope the server could not
 * place (`data-currency-source="default"`), switches the shown prices before they paint. It returns the
 * country so the scope's copy can use it. Kept as a string, not a bundled function, so a test can run
 * exactly what ships.
 */
export const COUNTRY_SNIPPET = `(function(){try{var m=document.cookie.match(/(?:^|; )${COUNTRY_COOKIE}=([A-Z]{2})/),c=m&&m[1];if(!c){var z="";try{z=Intl.DateTimeFormat().resolvedOptions().timeZone||""}catch(e){}var l=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""],au=/^Australia\\//.test(z);for(var i=0;i<l.length&&!au;i++)au=/-AU$/i.test(l[i]||"");c=au?"AU":"ZZ";document.cookie="${COUNTRY_COOKIE}="+c+"; path=/; max-age=31536000; samesite=lax"}var s=document.currentScript&&document.currentScript.parentElement;if(s&&s.getAttribute("data-currency-source")==="default")s.setAttribute("data-currency",c==="AU"?"aud":"usd");return c}catch(e){return null}})();`;
