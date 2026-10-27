import { describe, expect, it } from "vitest";
import { textSchema } from "@reelwalk/core";
import { invertLayers, textFillCss } from "../src/reel/look";

// Inverted titles (ADR 0091): the letters are the picture's negative, tinted by the title's colour.

describe("invertLayers", () => {
  it("white is one difference pass in white: a true negative, with no shadow, stroke or plate", () => {
    const layers = invertLayers("#FFFFFF", null);
    expect(layers.map((l) => [l.key, l.mixBlendMode])).toEqual([["negative", "difference"]]);
    expect(layers[0].face).toMatchObject({ color: "#ffffff", WebkitTextFillColor: "#ffffff", backgroundImage: "none", textShadow: "none", WebkitTextStroke: "0px", backgroundColor: "transparent" });
    // Cleared, not "none": the reveal blur is appended to the face's filter.
    expect("filter" in layers[0].face && layers[0].face.filter).toBeUndefined();
  });

  it("a colour multiplies the negative: pale yellow on dark, brown on a bright window", () => {
    const layers = invertLayers("#f2ef9c", null);
    expect(layers.map((l) => [l.key, l.mixBlendMode])).toEqual([["negative", "difference"], ["tint", "multiply"]]);
    expect(layers[1].face).toMatchObject({ color: "#f2ef9c", textShadow: "none" });
  });

  it("a gradient fill tints the negative with the gradient, without the fill's drop shadow", () => {
    const fill = textFillCss({ kind: "gradient", colors: ["#8a6a2a", "#f2d27a"] });
    const [negative, tint] = invertLayers("#ffffff", fill);
    expect(negative.face.backgroundImage).toBe("none");
    expect(tint.mixBlendMode).toBe("multiply");
    expect(tint.face.backgroundImage).toContain("linear-gradient");
    expect(tint.face.backgroundClip).toBe("text");
    expect(tint.face.filter).toBeUndefined();
  });
});

describe("the blend field", () => {
  const title = (blend?: string) => ({ id: "t", text: "dollar", startMs: 0, endMs: 2000, x: 0.5, y: 0.2, ...(blend ? { blend } : {}) });
  it("accepts invert, keeps saved titles as they were and rejects unknown modes", () => {
    expect(textSchema.parse(title("invert")).blend).toBe("invert");
    expect(textSchema.parse(title()).blend).toBeUndefined();
    expect(textSchema.parse(title("surface")).blend).toBe("surface");
    expect(textSchema.safeParse(title("overlay")).success).toBe(false);
  });
});
