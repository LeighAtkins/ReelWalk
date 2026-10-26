import type { CSSProperties } from "react";
import { brandFontFamily, BRAND_FONTS, colorMatchCss, type ColorMatch, type Filter, type TextAnimation, type TextStyle, type TextOverlay, type TextTreatment } from "@reelwalk/core";

/**
 * The presets as plain CSS filters: the editor's filter chips and the frame service's canvas, which have no SVG
 * defs to point at. The composition draws the corrected grade below (FILTER_GRADES, ADR 0083); these strings are
 * kept as the thumbnails' approximation of it.
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

/**
 * A preset as the controls of Remotion's `colorCorrection()` (remotion-markup color-correction.md, ADR 0083), with
 * its ranges: exposure in stops, temperature and tint -1..1, contrast and saturation as multipliers.
 */
export type Grade = { exposure?: number; temperature?: number; tint?: number; contrast?: number; saturation?: number };

/**
 * The presets, re-expressed from the CSS above. The guidance's two corrections: warmth is a white balance (a gain on
 * red against blue), not `sepia()` and `hue-rotate()`, which turn every hue (skin and sky with it) and wash the
 * colour into brown; and the order is exposure, white balance, contrast, saturation (the old strings set brightness
 * last, after saturation and contrast had been computed on the unexposed picture).
 */
export const FILTER_GRADES: Record<Filter, Grade | null> = {
  none: null,
  warm: { exposure: 0.04, temperature: 0.3, saturation: 1.12 },
  cool: { exposure: 0.03, temperature: -0.3, contrast: 1.03, saturation: 1.05 },
  vivid: { contrast: 1.08, saturation: 1.45 },
  mono: { contrast: 1.12, saturation: 0 },
  fade: { exposure: 0.11, contrast: 0.86, saturation: 0.78 },
  // Late low sun: warm, a touch darker, richer.
  golden: { exposure: -0.04, temperature: 0.55, tint: 0.05, contrast: 1.06, saturation: 1.22 },
  // Twilight: cooler, dimmer, a little magenta; the windows glow by comparison.
  dusk: { exposure: -0.28, temperature: -0.4, tint: 0.1, contrast: 1.12, saturation: 0.9 },
  // The bright, clean look of listing photography: lifted, a little more contrast and colour.
  crisp: { exposure: 0.11, contrast: 1.1, saturation: 1.12 },
};

/** The id of a preset's white-balance filter (drawn once by the composition, GradeFilters). */
export const whiteBalanceId = (filter: Filter) => `reelwalk-wb-${filter}`;

/**
 * A white balance as an feColorMatrix (sRGB): red and blue gains in opposite directions for temperature, a green gain
 * for tint (positive is magenta, less green), scaled so a mid grey keeps its luminance (Rec. 709 weights).
 */
export function whiteBalanceValues(temperature = 0, tint = 0): string {
  const r = 1 + 0.2 * temperature, g = 1 - 0.12 * tint, b = 1 - 0.2 * temperature;
  const k = 1 / (0.2126 * r + 0.7152 * g + 0.0722 * b);
  const f = (v: number) => (v * k).toFixed(4);
  return `${f(r)} 0 0 0 0  0 ${f(g)} 0 0 0  0 0 ${f(b)} 0 0  0 0 0 1 0`;
}

/** A preset's grade as a CSS filter chain in the guidance's order; undefined for "none". */
export function gradeCss(filter: Filter): string | undefined {
  const grade = FILTER_GRADES[filter];
  if (!grade) return undefined;
  const parts: string[] = [];
  if (grade.exposure) parts.push(`brightness(${(2 ** grade.exposure).toFixed(4)})`);
  if (grade.temperature || grade.tint) parts.push(`url(#${whiteBalanceId(filter)})`);
  if (grade.contrast !== undefined && grade.contrast !== 1) parts.push(`contrast(${grade.contrast})`);
  if (grade.saturation !== undefined && grade.saturation !== 1) parts.push(grade.saturation === 0 ? "grayscale(1)" : `saturate(${grade.saturation})`);
  return parts.join(" ") || undefined;
}

/**
 * A clip's whole colour treatment: the match onto the reel's reference look
 * (ADR 0070) first, so the footage agrees, then the preset grade on top of
 * footage that already does. Undefined when the clip has neither.
 */
export function clipFilterCss(clip: { id: string; filter: Filter; colorMatch?: ColorMatch | null }): string | undefined {
  const parts = [colorMatchCss(clip), gradeCss(clip.filter)].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

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
export const REEL_FONT_FAMILY = '"Archivo Variable", "Noto Sans JP Variable", "Noto Color Emoji", sans-serif';

/**
 * The "elegant" style's serif and the serif hook's (ADR 0083, the owner's choice of 2026-10-26): Playfair Display, a
 * high-contrast display serif that holds at title sizes on a phone. Japanese falls back to Noto Sans JP, emoji to Noto Color Emoji.
 */
export const ELEGANT_FONT_FAMILY = '"Playfair Display Variable", "Noto Sans JP Variable", "Noto Color Emoji", serif';
/** Cormorant Garamond, the thin classic serif: the title font "serif" (and the elegant style before ADR 0083). */
export const CORMORANT_FONT_FAMILY = '"Cormorant Garamond Variable", "Noto Sans JP Variable", "Noto Color Emoji", serif';
/** Bodoni Moda: the title font "editorial". */
export const BODONI_FONT_FAMILY = '"Bodoni Moda Variable", Georgia, "Noto Color Emoji", serif';

/**
 * The elegant serif is set smaller than the base size so the picture leads: Playfair at size 1 is about 53 px, a cap
 * height of about 37 px on the 1080x1920 frame (Playfair's capitals are taller than Cormorant's, which needed 0.78).
 */
const ELEGANT_SCALE = 0.7;
const CORMORANT_SCALE = 0.78;

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
  fadeQuick: "Quick fade",
  maskUp: "Mask up",
  trackIn: "Track in",
  blurIn: "Blur in",
};

/** Lacquer, the brand's one accent, for the status sticker. */
const LACQUER = "#c1272d";

/** A contrast edge and halo preserve small lettering over bright, detailed footage. */
export function textContrastCss(text: Pick<TextOverlay, "style" | "color" | "size" | "shadow">): CSSProperties {
  const mode = text.shadow ?? "auto";
  if (mode === "none") return { textShadow: "none", ...(text.style !== "outline" ? { WebkitTextStroke: "0px" } : {}) };
  if (mode === "auto" && ["box", "tag", "outline"].includes(text.style)) return {};
  const rgb = readableOn(text.color) === "#ffffff" ? "255,255,255" : "0,0,0";
  if (mode === "soft") return { textShadow: `0 1px 3px rgba(${rgb},0.65), 0 3px 12px rgba(${rgb},0.5)` };
  const edge = Math.max(1.25, Math.min(2, BASE_TEXT_PX * text.size * 0.018));
  return { textShadow: `0 1px 2px rgba(${rgb},0.95), 0 3px 8px rgba(${rgb},0.9), 0 0 20px rgba(${rgb},0.75)`,
    ...(text.style !== "outline" ? { WebkitTextStroke: `${edge}px rgba(${rgb},0.65)`, paintOrder: "stroke fill" as const } : {}) };
}

/** `#rrggbb` as `rgba(r, g, b, a)`. */
function withAlpha(color: string, alpha: number): string {
  const value = parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * A brand kit style's treatment as CSS (ADR 0078), over the text's own: the bundled brand face and weight, capitals, a
 * hard offset shadow (no blur), a plate with an edge, and a forward lean. Lengths are fractions of the font size, so the
 * look scales with the text. The lean is a `skewX` on the title (the fonts have no slant axis) and so also tilts a plate; it
 * is the only transform on the face, which the composition composes with its own scale where it sets one.
 */
export function brandCss(brand: TextTreatment, fontSize: number): CSSProperties {
  const px = (em: number) => em * fontSize;
  const spec = BRAND_FONTS[brand.font];
  const { shadow, plate } = brand;
  const edge = plate?.edge && plate.edge.width > 0 ? Math.max(1, px(plate.edge.width)) : 0;
  return {
    fontFamily: brandFontFamily(brand.font),
    fontWeight: brand.weight,
    fontStretch: "100%",
    fontStyle: brand.italic && spec.italic ? "italic" : "normal",
    textTransform: brand.caps ? "uppercase" : "none",
    // A hard shadow is a second copy of the letters: no blur, and none of the style's own halo or edge.
    textShadow: shadow ? `${px(shadow.dx).toFixed(2)}px ${px(shadow.dy).toFixed(2)}px 0 ${shadow.color}` : "none",
    WebkitTextStroke: "0px",
    ...(brand.slant ? { transform: `skewX(${-brand.slant}deg)` } : {}),
    ...(plate ? {
      backgroundColor: withAlpha(plate.color, plate.opacity),
      padding: `${px(plate.padY ?? 0.2).toFixed(2)}px ${px(plate.padX ?? 0.4).toFixed(2)}px`,
      borderRadius: px(plate.radius ?? 0),
      boxDecorationBreak: "clone" as const,
      WebkitBoxDecorationBreak: "clone" as const,
      ...(edge ? { border: `${edge.toFixed(2)}px solid ${plate.edge!.color}` } : {}),
    } : {}),
  };
}

export function textTreatmentCss(text: Pick<TextOverlay, "style" | "color" | "size" | "font" | "tracking" | "shadow" | "brand">): CSSProperties {
  const fonts = { auto: undefined, serif: CORMORANT_FONT_FAMILY, sans: REEL_FONT_FAMILY, editorial: BODONI_FONT_FAMILY };
  // The elegant style set in Cormorant by name keeps Cormorant's own size, weight and tracking (its look before ADR 0083).
  const cormorant = text.style === "elegant" && text.font === "serif"
    ? { fontSize: BASE_TEXT_PX * text.size * CORMORANT_SCALE, fontWeight: 600, letterSpacing: "0.06em" } : {};
  const base: CSSProperties = { ...textCss(text.style, text.color, text.size),
    ...(text.font && text.font !== "auto" ? { fontFamily: fonts[text.font] } : {}),
    ...cormorant,
    ...(text.tracking !== undefined ? { letterSpacing: `${text.tracking}em` } : {}),
    ...textContrastCss(text),
  };
  // A kit style replaces the style's own face, shadow and plate; reels saved before it have no `brand` and are untouched.
  return text.brand ? { ...base, ...brandCss(text.brand, Number(base.fontSize) || BASE_TEXT_PX * text.size) } : base;
}

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
        // Medium: Playfair's hairlines hold at this size, and its SemiBold reads heavy in sentence case.
        fontWeight: 500,
        lineHeight: 1.2,
        letterSpacing: "0.01em",
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
