import type { CSSProperties } from "react";
import type { Filter, TextStyle } from "@reelwalk/core";

/**
 * Colour filters are CSS filters, so the Player preview in the browser and the
 * headless Chrome in the worker produce the same picture.
 */
export const FILTER_CSS: Record<Filter, string | undefined> = {
  none: undefined,
  warm: "sepia(0.22) saturate(1.18) hue-rotate(-6deg) brightness(1.03)",
  cool: "saturate(1.05) hue-rotate(10deg) brightness(1.02) contrast(1.03)",
  vivid: "saturate(1.45) contrast(1.08)",
  mono: "grayscale(1) contrast(1.12)",
  fade: "contrast(0.86) brightness(1.08) saturate(0.78)",
};

export const FILTER_LABELS: Record<Filter, string> = {
  none: "Original",
  warm: "Warm",
  cool: "Cool",
  vivid: "Vivid",
  mono: "Mono",
  fade: "Faded",
};

/**
 * Archivo for Latin text, Noto Sans JP for Japanese. Both ship with the
 * bundle, so the worker needs no system fonts and renders what the preview shows.
 */
export const REEL_FONT_FAMILY = '"Archivo Variable", "Noto Sans JP Variable", sans-serif';

/** Base text size on the 1080-wide frame, before the overlay's own `size` scale. */
export const BASE_TEXT_PX = 76;

function readableOn(color: string): string {
  const value = parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0f2a44" : "#ffffff";
}

export const TEXT_STYLE_LABELS: Record<TextStyle, string> = {
  plain: "Classic",
  box: "Label",
  outline: "Outline",
  headline: "Headline",
};

/** Styles for a text overlay, in frame pixels (the composition is 1080x1920). */
export function textCss(style: TextStyle, color: string, size: number): CSSProperties {
  const fontSize = BASE_TEXT_PX * size;
  const base: CSSProperties = {
    fontFamily: REEL_FONT_FAMILY,
    fontSize,
    lineHeight: 1.12,
    textAlign: "center",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    color,
  };
  switch (style) {
    case "box":
      return {
        ...base,
        fontWeight: 700,
        fontStretch: "100%",
        color: readableOn(color),
        backgroundColor: color,
        padding: `${fontSize * 0.18}px ${fontSize * 0.36}px`,
        borderRadius: fontSize * 0.18,
        boxDecorationBreak: "clone",
        WebkitBoxDecorationBreak: "clone",
      };
    case "outline":
      return {
        ...base,
        fontWeight: 800,
        fontStretch: "75%",
        WebkitTextStroke: `${Math.max(2, fontSize * 0.045)}px ${readableOn(color)}`,
        paintOrder: "stroke fill",
      };
    case "headline":
      return {
        ...base,
        fontWeight: 850,
        fontStretch: "125%",
        fontSize: fontSize * 1.3,
        lineHeight: 1.02,
        letterSpacing: "-0.01em",
        textShadow: "0 6px 24px rgba(0, 0, 0, 0.45)",
      };
    default:
      return {
        ...base,
        fontWeight: 600,
        fontStretch: "100%",
        textShadow: "0 3px 14px rgba(0, 0, 0, 0.55), 0 1px 2px rgba(0, 0, 0, 0.5)",
      };
  }
}
