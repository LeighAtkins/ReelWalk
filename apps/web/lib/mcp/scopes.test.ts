import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPES, SCOPES, hasScopes, parseScopes } from "./scopes";

describe("scopes", () => {
  it("parses a space-separated list and reports unknown words", () => {
    expect(parseScopes("reels:read exports")).toEqual({ scopes: ["reels:read", "exports"], unknown: [] });
    expect(parseScopes("reels:read admin reels:read")).toEqual({ scopes: ["reels:read"], unknown: ["admin"] });
    expect(parseScopes("reels:read+reels:write")).toEqual({ scopes: ["reels:read", "reels:write"], unknown: [] });
    expect(parseScopes(undefined)).toEqual({ scopes: [], unknown: [] });
  });

  it("never grants AI credits by default and posting is not a scope at all", () => {
    expect(DEFAULT_SCOPES).not.toContain("ai:generate");
    expect(SCOPES.join(" ")).not.toMatch(/post|schedule|instagram/i);
  });

  it("checks that every needed scope is held", () => {
    expect(hasScopes(["reels:read", "exports"], ["exports"])).toBe(true);
    expect(hasScopes(["reels:read"], ["reels:read", "exports"])).toBe(false);
  });
});
