import { estimateLineWidth, TITLE_LEADING, type Measure, type TitleFont } from "@reelwalk/core";

let span: HTMLSpanElement | null = null;

/**
 * The measurer the composition hands to scene evaluation (ADR 0046): one line
 * laid out unwrapped in a hidden span with the title's font, weight, stretch
 * and letter spacing, in composition px. Canvas metrics ignore a variable
 * font's width axis (30% short), so a span it is. Without a DOM, or if the
 * span reads zero (a font not yet loaded), an estimate from the character count.
 */
export const domMeasure: Measure = (line: string, font: TitleFont) => {
  const fallback = { width: estimateLineWidth(line, font), height: font.fontSize * TITLE_LEADING };
  if (typeof document === "undefined") return fallback;
  try {
    if (!span) {
      span = document.createElement("span");
      Object.assign(span.style, { position: "absolute", left: "-99999px", top: "0", visibility: "hidden", whiteSpace: "nowrap", pointerEvents: "none" });
      document.body.appendChild(span);
    }
    Object.assign(span.style, {
      fontFamily: font.fontFamily ?? "sans-serif", fontWeight: String(font.fontWeight ?? 600), fontSize: `${font.fontSize}px`,
      fontStretch: font.fontStretch ?? "normal", letterSpacing: font.letterSpacing !== undefined ? `${font.letterSpacing}em` : "normal",
      // Tabular figures (a count-up) are wider than proportional ones in most faces: measure what is drawn.
      fontVariantNumeric: font.fontVariantNumeric ?? "normal",
    });
    span.textContent = line;
    const box = span.getBoundingClientRect();
    if (box.width > 0) return { width: box.width, height: box.height || fallback.height };
  } catch { /* the estimate below */ }
  return fallback;
};
