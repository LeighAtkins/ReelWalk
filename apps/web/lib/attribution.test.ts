import { describe, expect, it } from "vitest";
import { pickAttribution, planIntentOf, readAttribution, signupHrefFor, withAttribution } from "./attribution";

describe("pickAttribution", () => {
  it("keeps only the known utm and click-id keys", () => {
    const params = new URLSearchParams("utm_source=meta&utm_campaign=agents-oct&gclid=abc&fbclid=xyz&next=/evil&foo=bar");
    expect(pickAttribution(params)).toEqual({ utm_source: "meta", utm_campaign: "agents-oct", gclid: "abc", fbclid: "xyz" });
  });

  it("returns null when the visitor came without any", () => {
    expect(pickAttribution(new URLSearchParams("next=/x"))).toBeNull();
    expect(pickAttribution({})).toBeNull();
  });

  it("reads Next searchParams objects, taking the first of a repeated key", () => {
    expect(pickAttribution({ utm_source: ["a", "b"], utm_medium: "paid" })).toEqual({ utm_source: "a", utm_medium: "paid" });
  });

  it("reads form data, so the sign-up form's hidden fields survive", () => {
    const form = new FormData();
    form.set("utm_source", "instagram");
    form.set("name", "Not attribution");
    expect(pickAttribution(form)).toEqual({ utm_source: "instagram" });
  });

  it("strips control characters and caps long values", () => {
    const out = pickAttribution({ utm_campaign: `  spring\u0000\u001f sale  `, gclid: "x".repeat(500) });
    expect(out?.utm_campaign).toBe("spring sale");
    expect(out?.gclid).toHaveLength(200);
  });

  it("drops blank values", () => {
    expect(pickAttribution({ utm_source: "   ", fbclid: "" })).toBeNull();
  });
});

describe("withAttribution", () => {
  const attribution = { utm_source: "meta", fbclid: "a b" };

  it("appends to a bare path", () => {
    expect(withAttribution("/signup", attribution)).toBe("/signup?utm_source=meta&fbclid=a+b");
  });

  it("keeps an existing query and the fragment, and does not overwrite", () => {
    expect(withAttribution("/signup?utm_source=own&x=1#plans", attribution)).toBe("/signup?utm_source=own&x=1&fbclid=a+b#plans");
  });

  it("leaves the link alone when there is nothing to carry", () => {
    expect(withAttribution("/signup", null)).toBe("/signup");
  });
});

describe("readAttribution", () => {
  it("round-trips what was stored and ignores junk", () => {
    expect(readAttribution({ utm_source: "meta", surprise: "1" })).toEqual({ utm_source: "meta" });
    expect(readAttribution(null)).toBeNull();
    expect(readAttribution(["utm_source"])).toBeNull();
    expect(readAttribution("x")).toBeNull();
  });
});

describe("plan intent (ADR 0081)", () => {
  it("keeps a paid plan and an interval in canonical form, and ignores anything else", () => {
    expect(pickAttribution({ intent_plan: "agent", intent_interval: "YEAR" })).toEqual({ intent_plan: "AGENT", intent_interval: "year" });
    expect(pickAttribution({ intent_plan: "Studio" })).toEqual({ intent_plan: "OFFICE" });
    expect(pickAttribution({ intent_plan: "FREE", intent_interval: "week" })).toBeNull();
    expect(pickAttribution({ intent_plan: "<script>" })).toBeNull();
  });

  it("reads the intent back, defaulting to monthly", () => {
    expect(planIntentOf({ intent_plan: "AGENT", intent_interval: "year" })).toEqual({ plan: "AGENT", interval: "year" });
    expect(planIntentOf({ intent_plan: "OFFICE" })).toEqual({ plan: "OFFICE", interval: "month" });
    expect(planIntentOf({ utm_source: "meta" })).toBeNull();
    expect(planIntentOf(null)).toBeNull();
    // A stored value that was tampered with is not a plan.
    expect(planIntentOf(readAttribution({ intent_plan: "ROOT" }))).toBeNull();
  });

  it("builds a sign-up link, never a checkout link, that carries the plan and the ad parameters", () => {
    expect(signupHrefFor("AGENT", "month", null)).toBe("/signup?intent_plan=AGENT&intent_interval=month");
    expect(signupHrefFor("AGENT", "year", { utm_source: "meta" })).toBe("/signup?intent_plan=AGENT&intent_interval=year&utm_source=meta");
    expect(signupHrefFor("FREE", "month", null)).toBe("/signup");
  });

  it("round-trips through the sign-up form", () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ intent_plan: "AGENT", intent_interval: "year", utm_source: "meta" })) form.set(key, value);
    expect(planIntentOf(pickAttribution(form))).toEqual({ plan: "AGENT", interval: "year" });
  });
});
