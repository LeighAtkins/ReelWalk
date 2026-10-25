import { describe, expect, it } from "vitest";
import { consentChoices, grantableScopes } from "./consent";
import type { Scope } from "./scopes";

const ALL: Scope[] = ["reels:read", "reels:write", "exports", "ai:generate"];

describe("consent defaults (ADR 0079)", () => {
  it("ticks everything asked for except ai:generate, which is off by default even when the app requested it", () => {
    const choices = consentChoices(ALL, true);
    expect(choices.map((choice) => [choice.scope, choice.checked])).toEqual([
      ["reels:read", true],
      ["reels:write", true],
      ["exports", true],
      ["ai:generate", false],
    ]);
    expect(choices.every((choice) => choice.offered)).toBe(true);
  });

  it("does not offer ai:generate at all when the workspace has AI off", () => {
    const choices = consentChoices(ALL, false);
    expect(choices.find((choice) => choice.scope === "ai:generate")).toMatchObject({ offered: false });
    expect(choices.filter((choice) => choice.offered).map((choice) => choice.scope)).toEqual(["reels:read", "reels:write", "exports"]);
  });

  it("offers nothing extra when the app did not ask for ai:generate", () => {
    expect(consentChoices(["reels:read"], false)).toEqual([{ scope: "reels:read", offered: true, checked: true }]);
  });
});

describe("what may be granted", () => {
  it("is the ticked scopes the app asked for", () => {
    expect(grantableScopes(["reels:read", "exports"], ["reels:read", "reels:write"], true)).toEqual(["reels:read"]);
  });

  it("never includes ai:generate for a workspace with AI off, whatever was ticked or forged", () => {
    expect(grantableScopes(["reels:read", "ai:generate"], ALL, false)).toEqual(["reels:read"]);
    expect(grantableScopes(["ai:generate"], ALL, false)).toEqual([]);
  });

  it("includes ai:generate only when ticked, asked for, and the workspace allows it", () => {
    expect(grantableScopes(["ai:generate"], ALL, true)).toEqual(["ai:generate"]);
    expect(grantableScopes(["ai:generate"], ["reels:read"], true)).toEqual([]);
    expect(grantableScopes(["reels:read"], ALL, true)).toEqual(["reels:read"]);
  });

  it("lists a scope once", () => {
    expect(grantableScopes(["reels:read", "reels:read"], ALL, true)).toEqual(["reels:read"]);
  });
});
