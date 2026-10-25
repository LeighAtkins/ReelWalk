import { describe, expect, it } from "vitest";
import { LAST_MILE_KIT, resolveTextStyle, type TextOverlay } from "@reelwalk/core";
import { brandCss, textCss, textTreatmentCss } from "../src/reel/look";
import { titleFont } from "../src/reel/title-motion";

// Brand kit styles as CSS (ADR 0078): the composition draws them, and a text without one is drawn exactly as before.

function styled(name: string, text: Partial<Pick<TextOverlay, "size">> = {}) {
  const resolved = resolveTextStyle(LAST_MILE_KIT, name);
  if (!resolved.ok) throw new Error(resolved.message);
  return { ...resolved.patch, ...text };
}

describe("saved titles without a brand style", () => {
  it("get the same CSS as before: no brand keys, no transform, no plate", () => {
    for (const style of ["plain", "box", "outline", "headline", "elegant", "tag"] as const) {
      const css = textTreatmentCss({ style, color: "#ffffff", size: 1 });
      expect(css.transform).toBeUndefined();
      expect(css.textTransform === undefined || style === "tag").toBe(true);
      expect(css.border).toBeUndefined();
    }
    const plain = textTreatmentCss({ style: "plain", color: "#ffffff", size: 1, font: "serif", tracking: 0.1, shadow: "soft" });
    expect(plain).toEqual({ ...textCss("plain", "#ffffff", 1), fontFamily: expect.stringContaining("Cormorant"), letterSpacing: "0.1em", textShadow: expect.stringContaining("rgba(0,0,0,0.65)") });
  });
});

describe("lastmile-title", () => {
  const text = styled("lastmile-title");
  const css = textTreatmentCss(text);
  it("sets Big Shoulders Display at weight 900 in paper, leaning forward", () => {
    expect(String(css.fontFamily)).toMatch(/^"Big Shoulders Display"/);
    expect(css.fontWeight).toBe(900);
    expect(css.color).toBe("#f3f1ff");
    expect(css.transform).toBe("skewX(-10deg)");
    expect(css.fontStyle).toBe("normal");
  });
  it("has a hard magenta offset shadow, no blur, scaled to the font size, and none of the style's halo or edge", () => {
    const fontSize = Number(css.fontSize);
    const [dx, dy, blur, colour] = String(css.textShadow).split(" ");
    expect(parseFloat(dx)).toBeCloseTo(0.048 * fontSize, 1);
    expect(parseFloat(dy)).toBeCloseTo(0.04 * fontSize, 1);
    expect(blur).toBe("0");
    expect(colour).toBe("#ff2bd6");
    expect(String(css.textShadow)).not.toContain(",");
    expect(css.WebkitTextStroke).toBe("0px");
    expect(css.backgroundColor).toBeUndefined();
  });
  it("is 12 x 10 px at 250 px, proportionally", () => {
    const at250 = brandCss(text.brand!, 250);
    expect(String(at250.textShadow)).toBe("12.00px 10.00px 0 #ff2bd6");
  });
});

describe("lastmile-caption", () => {
  const text = styled("lastmile-caption");
  const css = textTreatmentCss(text);
  it("sets Atkinson Hyperlegible Bold in paper on an ink plate at 85% with a 3 px magenta edge", () => {
    expect(String(css.fontFamily)).toMatch(/^"Atkinson Hyperlegible"/);
    expect(css.fontWeight).toBe(700);
    expect(css.backgroundColor).toBe("rgba(7, 8, 14, 0.85)");
    expect(css.border).toBe("3.00px solid #ff2bd6");
    expect(css.textShadow).toBe("none");
    expect(css.transform).toBeUndefined();
  });
  it("makes the cyan variant's edge cyan and nothing else different", () => {
    const cyan = textTreatmentCss(styled("lastmile-caption-cyan"));
    expect(cyan.border).toBe("3.00px solid #22e6ff");
    expect(cyan.backgroundColor).toBe(css.backgroundColor);
  });
  it("scales the plate and edge with the text size", () => {
    const big = textTreatmentCss(styled("lastmile-caption", { size: 1.5 }));
    expect(parseFloat(String(big.border))).toBeCloseTo(6, 0);
  });
});

describe("lastmile-label and the measure", () => {
  it("sets capitals, and hands the measure the same transform so a lower-case label is measured as drawn", () => {
    const text = styled("lastmile-label");
    const css = textTreatmentCss(text);
    expect(css.textTransform).toBe("uppercase");
    expect(titleFont(text, css).textTransform).toBe("uppercase");
    expect(titleFont({ tracking: undefined, kinetic: undefined }, textTreatmentCss({ style: "plain", color: "#fff", size: 1 })).textTransform).toBeUndefined();
  });
  it("uses the font's own italic only where it ships one", () => {
    expect(brandCss({ style: "x", font: "atkinson-hyperlegible", weight: 400, italic: true }, 60).fontStyle).toBe("italic");
    expect(brandCss({ style: "x", font: "chakra-petch", weight: 600, italic: true }, 60).fontStyle).toBe("normal");
  });
});
