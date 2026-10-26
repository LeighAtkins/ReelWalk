import { describe, expect, it } from "vitest";
import { fitScreenTitle, screenTitleExtent, TITLE_MAX_WIDTH, TITLE_WRAP_WIDTH, type Measure } from "../src/scene";

/** A fixed-advance measurer: 0.6 em a character, so the widths are exact. */
const measure: Measure = (line, font) => ({ width: line.length * font.fontSize * 0.6, height: font.fontSize * 1.12 });
const W = 1080;
const font = { fontFamily: "Playfair Display Variable", fontWeight: 500, fontSize: 60 };
const centre = { x: 540, y: 330 };

describe("fitScreenTitle (ADR 0083)", () => {
  it("leaves a title that already fits exactly as it was", () => {
    const fitted = fitScreenTitle({ text: "Penthouse", style: "elegant" }, font, measure, centre, 1, W);
    expect(fitted).toEqual({ wrap: { mode: "line", maxWidth: W * 1.4 }, scale: 1, center: centre });
    const sentence = fitScreenTitle({ text: "A quiet chalet above the valley", style: "elegant" }, font, measure, centre, 1, W);
    expect(sentence).toEqual({ wrap: { mode: "wrap", width: W * TITLE_WRAP_WIDTH }, scale: 1, center: centre });
  });

  it("scales a single word down until it fits inside the frame instead of running off both edges", () => {
    const text = { text: "Extraordinarily-Magnificent", style: "headline" as const };
    const big = { ...font, fontSize: 148 };
    const width = text.text.length * 148 * 0.6;
    expect(width).toBeGreaterThan(W);
    const fitted = fitScreenTitle(text, big, measure, centre, 1, W);
    expect(width * fitted.scale).toBeCloseTo(W * TITLE_MAX_WIDTH, 6);
    // Its line is never capped narrower than the word, so it never breaks.
    expect(fitted.wrap.mode === "line" && fitted.wrap.maxWidth).toBeGreaterThanOrEqual(width);
  });

  it("widens a sentence's column for a word wider than the column, so the word never breaks mid-word", () => {
    const text = { text: "Breathtaking Kirribilli-Waterfront-Penthouse views", style: "elegant" as const };
    const longest = "Kirribilli-Waterfront-Penthouse".length * 60 * 0.6;
    expect(longest).toBeGreaterThan(W * TITLE_WRAP_WIDTH);
    const fitted = fitScreenTitle(text, font, measure, centre, 1, W);
    expect(fitted.wrap.mode === "wrap" && fitted.wrap.width).toBeGreaterThanOrEqual(longest);
    const box = screenTitleExtent(text, font, measure, fitted.wrap).width;
    expect(box * fitted.scale).toBeLessThanOrEqual(W * TITLE_MAX_WIDTH + 1e-6);
  });

  it("brings a user's scale down only as far as the frame needs", () => {
    const text = { text: "A quiet chalet above the valley with room for everyone", style: "elegant" as const };
    const fitted = fitScreenTitle(text, font, measure, centre, 1.5, W);
    const box = screenTitleExtent(text, font, measure, fitted.wrap).width;
    expect(fitted.scale).toBeLessThan(1.5);
    expect(box * fitted.scale).toBeCloseTo(W * TITLE_MAX_WIDTH, 6);
  });

  it("moves a title placed near an edge just far enough in to keep it inside the frame", () => {
    const text = { text: "Sold", style: "headline" as const };
    const fitted = fitScreenTitle(text, font, measure, { x: 20, y: 300 }, 1, W);
    const half = (4 * 60 * 0.6) / 2;
    expect(fitted.center.x).toBeCloseTo((W * (1 - TITLE_MAX_WIDTH)) / 2 + half, 6);
    expect(fitted.center.y).toBe(300);
  });

  it("fits the owner's twelve-word Playfair hook in the top of a 1080×1920 frame without shrinking it", () => {
    const hook = { text: "A six-bedroom alpine lodge in Zermatt, ski-in ski-out, offers over AUD 12.8M", style: "elegant" as const };
    const fitted = fitScreenTitle(hook, { ...font, fontSize: 66.5 }, measure, { x: 540, y: 0.17 * 1920 }, 1, W);
    expect(fitted.scale).toBe(1);
    const extent = screenTitleExtent(hook, { ...font, fontSize: 66.5 }, measure, fitted.wrap);
    expect(extent.width).toBeLessThanOrEqual(W * TITLE_MAX_WIDTH);
    // Centred at 17 % of the height, its lines stay inside the top 30 %.
    expect(0.17 * 1920 + extent.height / 2).toBeLessThanOrEqual(0.3 * 1920);
  });
});
