import type { CSSProperties } from "react";
import type { Filter, TextAnimation, TextStyle } from "@reelwalk/core";

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
  // Late low sun: warm, a touch darker, richer.
  golden: "sepia(0.38) saturate(1.35) hue-rotate(-12deg) brightness(0.97) contrast(1.06)",
  // Twilight: cooler, dimmer, blue in the shadows, the windows glow by comparison.
  dusk: "saturate(0.9) hue-rotate(18deg) brightness(0.82) contrast(1.12)",
  // The bright, clean look of listing photography: lifted, a little more contrast and colour.
  crisp: "brightness(1.08) contrast(1.1) saturate(1.12)",
};

export const FILTER_LABELS: Record<Filter, string> = {
  none: "Original",
  warm: "Warm",
  cool: "Cool",
  vivid: "Vivid",
  mono: "Mono",
  fade: "Faded",
  golden: "Golden hour",
  dusk: "Dusk",
  crisp: "Crisp",
};

/**
 * Archivo for Latin text, Noto Sans JP for Japanese. Both ship with the
 * bundle, so the worker needs no system fonts and renders what the preview shows.
 */
export const REEL_FONT_FAMILY = '"Archivo Variable", "Noto Sans JP Variable", sans-serif';

/** A thin classic serif for the "elegant" style; Japanese falls back to Noto Sans JP. */
export const ELEGANT_FONT_FAMILY = '"Cormorant Garamond Variable", "Noto Sans JP Variable", serif';

/**
 * The elegant serif is set smaller than the base size: at size 1 it is about
 * 59 px, a cap height of about 37 px on the 1080x1920 frame, so the picture leads.
 */
const ELEGANT_SCALE = 0.78;

/** Seconds the elegant style takes to fade in, and to fade out before it ends. */
export const ELEGANT_FADE_S = 0.6;

/** Base text size on the 1080-wide frame, before the overlay's own `size` scale. */
export const BASE_TEXT_PX = 76;

function readableOn(color: string): string {
  const value = parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0a0a0a" : "#ffffff";
}

export const TEXT_STYLE_LABELS: Record<TextStyle, string> = {
  plain: "Classic",
  box: "Label",
  outline: "Outline",
  headline: "Headline",
  elegant: "Elegant",
  tag: "Sticker",
};

export const TEXT_ANIMATION_LABELS: Record<TextAnimation, string> = {
  auto: "Style's own",
  pop: "Pop",
  fade: "Fade",
  rise: "Rise",
  type: "Type",
  none: "None",
};

/** Lacquer, the brand's one accent, for the status sticker. */
const LACQUER = "#c1272d";

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
    case "tag":
      // A small sticker: capitals, wide-set, on lacquer unless another colour was chosen.
      return {
        ...base,
        fontWeight: 800,
        fontStretch: "112%",
        fontSize: fontSize * 0.7,
        lineHeight: 1,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: color.toLowerCase() === "#ffffff" ? "#ffffff" : readableOn(color),
        backgroundColor: color.toLowerCase() === "#ffffff" ? LACQUER : color,
        padding: `${fontSize * 0.2}px ${fontSize * 0.34}px`,
        borderRadius: fontSize * 0.1,
        boxShadow: "0 6px 24px rgba(0, 0, 0, 0.35)",
      };
    case "elegant":
      return {
        ...base,
        fontFamily: ELEGANT_FONT_FAMILY,
        fontSize: fontSize * ELEGANT_SCALE,
        // SemiBold: Cormorant's hairlines vanish at Medium on a bright sky at this size.
        fontWeight: 600,
        lineHeight: 1.2,
        letterSpacing: "0.06em",
        // A soft glow plus a faint tight edge: not a visible drop shadow, but enough
        // to hold white serif on a blown-out window or sky.
        textShadow: "0 1px 3px rgba(0, 0, 0, 0.28), 0 1px 14px rgba(0, 0, 0, 0.4)",
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
