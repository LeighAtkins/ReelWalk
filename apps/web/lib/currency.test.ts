import { describe, expect, it } from "vitest";
import { COUNTRY_SNIPPET, currencyForCountry, resolveCurrency } from "./currency";

const evidence = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) => ({
  header: (name: string) => headers[name] ?? null,
  cookie: (name: string) => cookies[name],
});

describe("resolveCurrency (ADR 0085)", () => {
  it("defaults to US$ with nothing to go on, and says so", () => {
    expect(resolveCurrency(evidence())).toEqual({ currency: "usd", source: "default", country: null });
  });

  it("reads a CDN's country header first", () => {
    expect(resolveCurrency(evidence({ "cf-ipcountry": "AU" }, { rw_country: "ZZ" }))).toMatchObject({ currency: "aud", source: "header", country: "AU" });
    expect(resolveCurrency(evidence({ "x-vercel-ip-country": "nz" }, { rw_country: "AU" }))).toMatchObject({ currency: "usd", source: "header", country: "NZ" });
    expect(resolveCurrency(evidence({ "cloudfront-viewer-country": "AU" }))).toMatchObject({ currency: "aud", source: "header" });
  });

  it("ignores unknown and malformed countries", () => {
    expect(resolveCurrency(evidence({ "cf-ipcountry": "XX" }, { rw_country: "AU" }))).toMatchObject({ currency: "aud", source: "cookie" });
    expect(resolveCurrency(evidence({ "cf-ipcountry": "T1" }))).toMatchObject({ source: "default", currency: "usd" });
    expect(resolveCurrency(evidence({}, { rw_country: "Australia" }))).toMatchObject({ source: "default", currency: "usd" });
  });

  it("falls back to the browser's guess in rw_country", () => {
    expect(resolveCurrency(evidence({}, { rw_country: "AU" }))).toEqual({ currency: "aud", source: "cookie", country: "AU" });
    expect(resolveCurrency(evidence({}, { rw_country: "ZZ" }))).toEqual({ currency: "usd", source: "cookie", country: "ZZ" });
  });

  it("lets the visitor's own pick beat every other evidence", () => {
    expect(resolveCurrency(evidence({ "cf-ipcountry": "AU" }, { rw_currency: "usd" }))).toEqual({ currency: "usd", source: "choice", country: "AU" });
    expect(resolveCurrency(evidence({}, { rw_currency: "aud", rw_country: "ZZ" }))).toMatchObject({ currency: "aud", source: "choice" });
    expect(resolveCurrency(evidence({}, { rw_currency: "eur", rw_country: "AU" }))).toMatchObject({ currency: "aud", source: "cookie" });
  });

  it("charges A$ only in Australia", () => {
    expect(currencyForCountry("AU")).toBe("aud");
    expect(currencyForCountry("US")).toBe("usd");
    expect(currencyForCountry("MY")).toBe("usd");
    expect(currencyForCountry(null)).toBe("usd");
  });
});

/** Runs the exact snippet the pages inline, against a fake browser. */
function runSnippet({ timeZone, languages, cookie = "", source }: { timeZone: string; languages: string[]; cookie?: string; source?: string }) {
  const attributes: Record<string, string> = source ? { "data-currency-source": source, "data-currency": "usd" } : {};
  const scope = { getAttribute: (name: string) => attributes[name] ?? null, setAttribute: (name: string, value: string) => (attributes[name] = value) };
  const document = { cookie, currentScript: { parentElement: scope } };
  const Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) };
  const navigator = { languages, language: languages[0] };
  const country = new Function("document", "Intl", "navigator", `return ${COUNTRY_SNIPPET}`)(document, Intl, navigator);
  return { country, cookie: document.cookie, currency: attributes["data-currency"] };
}

describe("COUNTRY_SNIPPET", () => {
  it("places a phone in an Australian time zone in AU and remembers it", () => {
    const result = runSnippet({ timeZone: "Australia/Sydney", languages: ["en-US"] });
    expect(result.country).toBe("AU");
    expect(result.cookie).toMatch(/^rw_country=AU; path=\/; max-age=31536000/);
  });

  it("places an en-AU browser in AU wherever its clock is", () => {
    expect(runSnippet({ timeZone: "Asia/Kuala_Lumpur", languages: ["en-GB", "en-AU"] }).country).toBe("AU");
  });

  it("puts everyone else in ZZ", () => {
    expect(runSnippet({ timeZone: "America/New_York", languages: ["en-US"] }).country).toBe("ZZ");
    expect(runSnippet({ timeZone: "Pacific/Auckland", languages: ["en-NZ"] }).country).toBe("ZZ");
  });

  it("keeps an existing guess instead of guessing again", () => {
    const result = runSnippet({ timeZone: "Australia/Perth", languages: ["en-AU"], cookie: "a=1; rw_country=ZZ" });
    expect(result.country).toBe("ZZ");
    expect(result.cookie).toBe("a=1; rw_country=ZZ");
  });

  it("corrects the shown prices only in a scope the server could not place", () => {
    expect(runSnippet({ timeZone: "Australia/Brisbane", languages: ["en-US"], source: "default" }).currency).toBe("aud");
    expect(runSnippet({ timeZone: "Australia/Brisbane", languages: ["en-US"], source: "choice" }).currency).toBe("usd");
    expect(runSnippet({ timeZone: "Australia/Brisbane", languages: ["en-US"], source: "fixed" }).currency).toBe("usd");
  });
});
