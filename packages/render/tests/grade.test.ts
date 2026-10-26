import { describe, expect, it } from "vitest";
import { FILTERS } from "@reelwalk/core";
import { clipFilterCss, FILTER_GRADES, gradeCss, textTreatmentCss, whiteBalanceId, whiteBalanceValues } from "../src/reel/look";

describe("preset grades in Remotion's colour-correction order (ADR 0083)", () => {
  it("has a grade for every filter the schema allows", () => {
    for (const filter of FILTERS) expect(filter in FILTER_GRADES).toBe(true);
    expect(gradeCss("none")).toBeUndefined();
  });

  it("sets exposure first, then the white balance, contrast and saturation, and never turns hues", () => {
    expect(gradeCss("golden")).toBe(`brightness(${(2 ** -0.04).toFixed(4)}) url(#${whiteBalanceId("golden")}) contrast(1.06) saturate(1.22)`);
    for (const filter of FILTERS) expect(gradeCss(filter) ?? "").not.toMatch(/hue-rotate|sepia/);
    expect(gradeCss("mono")).toBe("contrast(1.12) grayscale(1)");
  });

  it("warms by trading blue for red and keeps a mid grey's luminance", () => {
    const m = whiteBalanceValues(0.5, 0).split(/\s+/).map(Number);
    const [r, g, b] = [m[0], m[6], m[12]];
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(1, 3);
    expect(whiteBalanceValues(0, 0)).toBe("1.0000 0 0 0 0  0 1.0000 0 0 0  0 0 1.0000 0 0  0 0 0 1 0");
  });

  it("puts the colour match before the grade", () => {
    expect(clipFilterCss({ id: "c1", filter: "vivid" })).toBe("contrast(1.08) saturate(1.45)");
  });
});

describe("the elegant style's face (ADR 0083)", () => {
  const text = { style: "elegant" as const, color: "#ffffff", size: 1 };
  it("is Playfair Display by default", () => {
    expect(String(textTreatmentCss(text).fontFamily)).toMatch(/^"Playfair Display Variable"/);
    expect(textTreatmentCss(text).fontWeight).toBe(500);
  });
  it("keeps Cormorant, at its own size, weight and tracking, when the title asks for the serif", () => {
    const css = textTreatmentCss({ ...text, font: "serif" });
    expect(String(css.fontFamily)).toMatch(/^"Cormorant Garamond Variable"/);
    expect(css).toMatchObject({ fontWeight: 600, letterSpacing: "0.06em", fontSize: 76 * 0.78 });
  });
  it("keeps Bodoni for the editorial face", () => {
    expect(String(textTreatmentCss({ ...text, font: "editorial" }).fontFamily)).toMatch(/^"Bodoni Moda Variable"/);
  });
});
