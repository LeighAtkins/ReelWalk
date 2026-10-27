import { describe, expect, it } from "vitest";
import { FONT_TIGHT_TRACKING, INTER_TIGHT_FONT_FAMILY, invertLayers, textTreatmentCss } from "../src/reel/look";

// The focus captions' typeface (ADR 0092): Inter Tight, a choice beside the style's own; nothing changes by default.

const title = { style: "headline" as const, color: "#ffffff", size: 1, shadow: "none" as const, brand: undefined };

describe("the tight title font", () => {
  it("sets Inter Tight with tighter tracking than its style", () => {
    const css = textTreatmentCss({ ...title, font: "tight" });
    expect(css.fontFamily).toBe(INTER_TIGHT_FONT_FAMILY);
    expect(String(css.fontFamily)).toMatch(/^"Inter Tight Variable"/);
    expect(css.letterSpacing).toBe(FONT_TIGHT_TRACKING);
  });

  it("keeps a title's own tracking and weight", () => {
    const css = textTreatmentCss({ ...title, font: "tight", tracking: -0.01, weight: 600 });
    expect(css.letterSpacing).toBe("-0.01em");
    expect(css.fontWeight).toBe(600);
  });

  it("leaves every other typeface as it was", () => {
    for (const font of [undefined, "auto", "sans", "serif", "editorial"] as const) {
      const css = textTreatmentCss({ ...title, font });
      expect(String(css.fontFamily)).not.toContain("Inter Tight");
      expect(css.letterSpacing).not.toBe(FONT_TIGHT_TRACKING);
    }
    // The elegant serif stays Playfair: the house style is unchanged.
    expect(String(textTreatmentCss({ ...title, style: "elegant" }).fontFamily)).toMatch(/^"Playfair Display Variable"/);
  });

  it("inverts like any other face: the negative pass replaces colour and shadow, not the family or tracking", () => {
    const css = textTreatmentCss({ ...title, font: "tight" });
    const [negative] = invertLayers("#ffffff", null);
    const face = { ...css, ...negative.face };
    expect(face.fontFamily).toBe(INTER_TIGHT_FONT_FAMILY);
    expect(face.letterSpacing).toBe(FONT_TIGHT_TRACKING);
    expect(negative.mixBlendMode).toBe("difference");
  });
});
