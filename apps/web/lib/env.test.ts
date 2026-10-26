import { afterEach, describe, expect, it } from "vitest";
import { env, envWarnings, parseServerEnv } from "../env";

describe("parseServerEnv", () => {
  it("reads Terraform's 'unset' and empty strings as absent, with validation on or skipped", () => {
    for (const NODE_ENV of ["production", "test"]) {
      const parsed = parseServerEnv({ NODE_ENV, STRIPE_SECRET_KEY: "unset", STRIPE_WEBHOOK_SECRET: "", STRIPE_PRICE_AGENT_MONTHLY: "price_a", SAMPLE_REEL_URL: "https://cdn/a.mp4" });
      expect(parsed.STRIPE_SECRET_KEY).toBeUndefined();
      expect(parsed.STRIPE_WEBHOOK_SECRET).toBeUndefined();
      expect(parsed.STRIPE_PRICE_AGENT_MONTHLY).toBe("price_a");
      expect(parsed.SAMPLE_REEL_URL).toBe("https://cdn/a.mp4");
    }
  });

  it("boots with nothing set: every variable is optional", () => {
    expect(() => parseServerEnv({ NODE_ENV: "production" })).not.toThrow();
  });

  it("does not touch the source it parses", () => {
    const source = { NODE_ENV: "production", STRIPE_SECRET_KEY: "" };
    parseServerEnv(source);
    expect(source).toEqual({ NODE_ENV: "production", STRIPE_SECRET_KEY: "" });
  });
});

describe("env", () => {
  const before = process.env.STRIPE_PRICE_AI_TOP_UP;
  afterEach(() => {
    if (before === undefined) delete process.env.STRIPE_PRICE_AI_TOP_UP;
    else process.env.STRIPE_PRICE_AI_TOP_UP = before;
  });

  it("follows process.env as it changes, as the direct reads did", () => {
    process.env.STRIPE_PRICE_AI_TOP_UP = "price_top_up";
    expect(env.STRIPE_PRICE_AI_TOP_UP).toBe("price_top_up");
    process.env.STRIPE_PRICE_AI_TOP_UP = "unset";
    expect(env.STRIPE_PRICE_AI_TOP_UP).toBeUndefined();
  });
});

describe("envWarnings", () => {
  it("names values that look wrong without failing or printing them", () => {
    const warnings = envWarnings(parseServerEnv({ NODE_ENV: "production", STRIPE_PRICE_AGENT_MONTHLY: "prod_oops", STRIPE_WEBHOOK_SECRET: "whsec_1", STRIPE_SECRET_KEY: "rk_live_1", APP_URL: "reelwalking.com" }));
    expect(warnings).toEqual(["STRIPE_PRICE_AGENT_MONTHLY does not start with price_", "APP_URL does not start with http:// or https://"]);
    expect(warnings.join()).not.toContain("rk_live_1");
  });
});
