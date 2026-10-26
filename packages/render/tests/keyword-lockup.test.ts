import { describe, expect, it } from "vitest";
import { revealFrames, revealStyle } from "../src/reel/toolbox/title-reveal";
import { textFillCss, textTreatmentCss } from "../src/reel/look";

/** The keyword lockup's drawing (ADR 0089): its measured arrival, its fill and the caption words' italic. */
describe("keyword lockup drawing", () => {
  const FPS = 30, D = 60;

  it("arrives out of an 8 px blur in 200 ms with no drift, and goes in 150 ms (measured on reel 3)", () => {
    expect(revealFrames("blurQuick", FPS, D)).toEqual({ enter: 6, exit: 5 });
    const first = revealStyle("blurQuick", 0, FPS, D);
    expect(first.opacity).toBe(0);
    expect(first.blurPx).toBe(8);
    expect(first.offsetY).toBe(0);
    expect(revealStyle("blurQuick", 6, FPS, D).opacity).toBe(1);
    // It resolves evenly (reel 3 sharpens over 5-6 frames): half way in at frame 2, not already sharp.
    const third = revealStyle("blurQuick", 2, FPS, D);
    expect(third.opacity).toBeGreaterThan(0.45);
    expect(third.opacity).toBeLessThan(0.65);
    expect(third.blurPx).toBeGreaterThan(2.5);
  });

  it("fills the letters with a gradient or a picture, clipped to the glyphs, with a drop shadow instead of a text shadow", () => {
    expect(textFillCss(undefined)).toBeNull();
    const gradient = textFillCss({ kind: "gradient", colors: ["#ffffff", "#c9cdd2"], angle: 180 })!;
    expect(gradient).toMatchObject({ backgroundImage: "linear-gradient(180deg, #ffffff, #c9cdd2)", backgroundClip: "text", WebkitBackgroundClip: "text", color: "transparent", textShadow: "none" });
    expect(String(gradient.filter)).toMatch(/^drop-shadow/);
    expect(textFillCss({ kind: "image", assetId: "a" }, "https://x/y.jpg")!.backgroundImage).toBe('url("https://x/y.jpg")');
    // A picture fill whose asset is missing keeps the letters in their colour.
    expect(textFillCss({ kind: "image", assetId: "a" })).toBeNull();
  });

  it("sets a lockup's weight and italic, and leaves a title without them as it was", () => {
    const base = { style: "elegant" as const, color: "#ffffff", size: 4 };
    expect(textTreatmentCss({ ...base, weight: 600 }).fontWeight).toBe(600);
    expect(textTreatmentCss({ ...base, italic: true }).fontStyle).toBe("italic");
    expect(textTreatmentCss(base)).toEqual(textTreatmentCss({ ...base, italic: undefined, weight: undefined }));
    expect(textTreatmentCss(base).fontStyle).toBeUndefined();
  });
});
