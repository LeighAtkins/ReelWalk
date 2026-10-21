import { describe, expect, it } from "vitest";

// A plain Node script (no build step); loaded by path so the worker's typecheck does not need its types.
const scriptPath = "../scripts/seed-presenter.mjs";
const { originOf } = await import(scriptPath) as { originOf(url: string): string | null };

describe("presenter seeding script (ADR 0056)", () => {
  it("matches the tab by exact origin, never by prefix", () => {
    const expected = originOf("https://reelwalking.com");
    expect(originOf("https://reelwalking.com/reels/abc?x=1")).toBe(expected);
    expect(originOf("https://reelwalking.com.attacker.invalid/")).not.toBe(expected);
    expect(originOf("https://reelwalking.com@attacker.invalid/")).not.toBe(expected);
    expect(originOf("http://reelwalking.com/")).not.toBe(expected);
    expect(originOf("not a url")).toBeNull();
  });
});
