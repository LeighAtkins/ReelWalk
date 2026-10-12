import { describe, expect, it } from "vitest";
import { normalizeHandle } from "../src";

describe("normalizeHandle", () => {
  it("strips the @ and lowercases", () => {
    expect(normalizeHandle("@Northside.Realty")).toBe("northside.realty");
    expect(normalizeHandle("  reel_walk ")).toBe("reel_walk");
  });

  it("accepts a pasted profile URL", () => {
    expect(normalizeHandle("https://www.instagram.com/reelwalking/")).toBe("reelwalking");
    expect(normalizeHandle("instagram.com/reelwalking?igsh=abc")).toBe("reelwalking");
  });

  it("returns null for nothing or for characters Instagram does not allow", () => {
    expect(normalizeHandle("")).toBeNull();
    expect(normalizeHandle("@")).toBeNull();
    expect(normalizeHandle("has space")).toBeNull();
    expect(normalizeHandle("a".repeat(31))).toBeNull();
    expect(normalizeHandle(undefined)).toBeNull();
  });
});
