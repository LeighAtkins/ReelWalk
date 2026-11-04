import { describe, expect, it } from "vitest";
import { textGlowFilter } from "../src/reel/look";

describe("textGlowFilter", () => {
  it("is nothing without a glow", () => {
    expect(textGlowFilter(undefined, 200)).toBeNull();
  });
  it("draws a tight and a wide halo, scaled to the type, in the glow's colour", () => {
    const filter = textGlowFilter({ color: "#ff2fd0", radius: 0.1, strength: 1 }, 200)!;
    expect(filter).toBe("drop-shadow(0 0 9.0px #ff2fd0ff) drop-shadow(0 0 30.0px #ff2fd0bf)");
    expect(textGlowFilter({ color: "#ff2fd0", radius: 0.1, strength: 1 }, 400)).toContain("60.0px");
  });
  it("fades with its strength", () => {
    expect(textGlowFilter({ color: "#ffffff", radius: 0.1, strength: 0.5 }, 200)).toContain("#ffffff80");
  });
});
