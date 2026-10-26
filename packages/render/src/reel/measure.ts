import { fitText, measureText } from "@remotion/layout-utils";
import { estimateLineWidth, TITLE_LEADING, type Measure, type TitleFont } from "@reelwalk/core";

/**
 * The measurer the composition hands to scene evaluation (ADR 0046): Remotion's `measureText` (ADR 0083), which lays
 * one unwrapped line out in a hidden span with the title's font, weight, stretch, tracking, figures and case, in
 * composition px (a span, so a variable font's width axis counts; canvas metrics ignore it).
 *
 * `measureText` caches every result by its text and font for the life of the page, so a line measured before its
 * face has loaded would keep the fallback font's width. So nothing is measured until `ready` (useFontsFor's answer):
 * before that, and without a DOM, the line is estimated from the faces' measured advances (core's font metrics),
 * which is never cached. `fontVariantNumeric` and `fontStretch` go through `additionalStyles` because measureText's
 * cache key leaves its own `fontVariantNumeric` out: tabular and proportional figures would share one entry.
 */
export function layoutMeasure(ready: boolean): Measure {
  return (line: string, font: TitleFont) => {
    const fallback = { width: estimateLineWidth(line, font), height: font.fontSize * TITLE_LEADING };
    if (!ready || typeof document === "undefined") return fallback;
    try {
      const box = measureText({
        text: line,
        fontFamily: font.fontFamily ?? "sans-serif",
        fontSize: font.fontSize,
        fontWeight: String(font.fontWeight ?? 600),
        letterSpacing: font.letterSpacing !== undefined ? `${font.letterSpacing}em` : undefined,
        textTransform: (font.textTransform ?? "none") as "none",
        additionalStyles: { fontStretch: font.fontStretch ?? "normal", fontVariantNumeric: font.fontVariantNumeric ?? "normal" },
      });
      if (box.width > 0) return { width: box.width, height: box.height || fallback.height };
    } catch { /* the estimate */ }
    return fallback;
  };
}


/**
 * The largest size up to `maxSize` at which `text` fits `withinWidth` px, by Remotion's `fitText` (ADR 0083): the whole
 * string when it never wraps (`unit: "line"`), or its widest word when it wraps between words (`unit: "word"`), so a
 * card's price or a hook's big word is never cut off or broken mid-word. `maxSize` until the faces are `ready` (the
 * frame is held until then; see layoutMeasure on the cache).
 */
export function fittedSize(input: { text: string; unit: "line" | "word"; fontFamily: string; fontWeight: number; letterSpacing?: string; fontStretch?: string; maxSize: number; withinWidth: number; ready: boolean }): number {
  const { text, unit, maxSize, withinWidth, ready } = input;
  if (!ready || typeof document === "undefined" || !text.trim()) return maxSize;
  const pieces = unit === "line" ? text.split("\n") : text.split(/\s+/);
  try {
    const sizes = pieces.filter((piece) => piece.trim()).map((piece) => fitText({
      text: piece, withinWidth, fontFamily: input.fontFamily, fontWeight: String(input.fontWeight), letterSpacing: input.letterSpacing,
      additionalStyles: input.fontStretch ? { fontStretch: input.fontStretch } : undefined,
    }).fontSize);
    return Math.min(maxSize, ...sizes);
  } catch {
    return maxSize;
  }
}
