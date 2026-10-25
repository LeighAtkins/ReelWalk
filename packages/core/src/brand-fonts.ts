/**
 * Brand fonts and the text treatment they carry (ADR 0078).
 *
 * A brand kit (a workspace's own look: fonts, palette, named text styles) can use
 * only fonts the composition bundles, because preview and export are one Remotion
 * composition and the worker has no system fonts. This is the registry of those
 * fonts: an id the timeline can store, the CSS family the composition declares
 * for it (`packages/render/src/reel/brand-fonts/brand-fonts.css`), and which
 * weights exist. Every file is SIL Open Font Licence 1.1; the licence texts sit
 * beside the files (`packages/render/src/reel/brand-fonts/`, with a NOTICE.md) and `BRAND_FONT_NOTICE` is the same attribution as text.
 *
 * `textTreatmentSchema` is what a text overlay stores when a kit style was applied
 * to it: self-contained (font, weight, slant, hard shadow, plate), so a saved reel
 * renders without looking the kit up, and a kit changing later never re-styles it.
 */
import { z } from "zod";

export type BrandFontSpec = {
  /** The CSS font-family the composition declares. */
  family: string;
  /** What the picker shows. */
  label: string;
  /** Comma-separated fallbacks if the file fails to load. */
  fallback: string;
  /** A variable font takes any weight in `[min, max]`; a static one only the weights it ships. */
  weights: { variable: true; min: number; max: number } | { variable: false; available: readonly number[] };
  /** The family ships a real italic face (otherwise `italic` is a browser-made oblique, and `slant` is a skew). */
  italic: boolean;
  /** Who to credit in the licence notice. */
  copyright: string;
};

export const BRAND_FONTS = {
  "big-shoulders-display": {
    family: "Big Shoulders Display",
    label: "Big Shoulders Display",
    fallback: '"Archivo Variable", Impact, sans-serif',
    weights: { variable: true, min: 100, max: 900 },
    italic: false,
    copyright: "Copyright 2019 The Big Shoulders Project Authors (https://github.com/xotypeco/big_shoulders)",
  },
  "chakra-petch": {
    family: "Chakra Petch",
    label: "Chakra Petch",
    fallback: '"Archivo Variable", sans-serif',
    weights: { variable: false, available: [500, 600, 700] },
    italic: false,
    copyright: "Copyright 2018 The Chakra Petch Project Authors (https://github.com/m4rc1e/Chakra-Petch.git)",
  },
  "atkinson-hyperlegible": {
    family: "Atkinson Hyperlegible",
    label: "Atkinson Hyperlegible",
    fallback: '"Archivo Variable", "Noto Sans JP Variable", sans-serif',
    weights: { variable: false, available: [400, 700] },
    italic: true,
    copyright: "Copyright 2020 Braille Institute of America, Inc.",
  },
  anton: {
    family: "Anton",
    label: "Anton",
    fallback: '"Archivo Variable", Impact, sans-serif',
    weights: { variable: false, available: [400] },
    italic: false,
    copyright: "Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git)",
  },
  "caveat-brush": {
    family: "Caveat Brush",
    label: "Caveat Brush",
    fallback: "cursive",
    weights: { variable: false, available: [400] },
    italic: false,
    copyright: "Copyright 2015 Google Inc. All Rights Reserved.",
  },
} as const satisfies Record<string, BrandFontSpec>;

export type BrandFontId = keyof typeof BRAND_FONTS;
export const BRAND_FONT_IDS = Object.keys(BRAND_FONTS) as [BrandFontId, ...BrandFontId[]];

/** True when `weight` is one the font can draw: inside a variable font's range, or one of a static font's files. */
export function brandFontHasWeight(id: BrandFontId, weight: number): boolean {
  const spec: BrandFontSpec = BRAND_FONTS[id];
  return spec.weights.variable ? weight >= spec.weights.min && weight <= spec.weights.max : spec.weights.available.includes(weight);
}

/** The CSS `font-family` value for a brand font: its family first, then its fallbacks. */
export function brandFontFamily(id: BrandFontId): string {
  const spec: BrandFontSpec = BRAND_FONTS[id];
  return `"${spec.family}", ${spec.fallback.replace(/, ([a-z-]+)$/, ', "Noto Color Emoji", $1')}`;
}

/** The attribution that ships with the fonts (SIL OFL 1.1 asks that the copyright notices and licence travel with them). */
export const BRAND_FONT_NOTICE = (Object.values(BRAND_FONTS) as BrandFontSpec[])
  .map((spec) => `${spec.label}: ${spec.copyright}. SIL Open Font License 1.1.`)
  .join("\n");

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
/** A length as a fraction of the title's font size, so a treatment scales with the text. */
const em = (min: number, max: number) => z.number().min(min).max(max);

/** A kit style's name: lowercase words joined by hyphens, as `lastmile-title`. */
export const styleNameSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40);

/**
 * How a kit style dresses a title, beyond what a text overlay already has (colour, size, tracking):
 *  - `font`/`weight`: a bundled brand face; a variable font takes any weight in range.
 *  - `slant`: degrees the letters lean forward. A faux slant (a `skewX` on the title), for Big Shoulders Display
 *    has no slant axis; it applies to the whole title, plate included.
 *  - `italic`: the family's own italic face where it ships one (Atkinson Hyperlegible).
 *  - `caps`: set in capitals.
 *  - `shadow`: a hard offset shadow, no blur, as a fraction of the font size (dx right, dy down).
 *  - `plate`: a filled box behind the words with an opacity and an optional edge.
 */
const lookShape = {
  font: z.enum(BRAND_FONT_IDS),
  weight: z.number().int().min(100).max(900),
  slant: z.number().min(-20).max(20).optional(),
  italic: z.boolean().optional(),
  caps: z.boolean().optional(),
  shadow: z.object({ dx: em(-0.5, 0.5), dy: em(-0.5, 0.5), color: hex }).optional(),
  plate: z
    .object({
      color: hex,
      opacity: z.number().min(0).max(1),
      edge: z.object({ width: em(0, 0.25), color: hex }).optional(),
      radius: em(0, 1).optional(),
      padX: em(0, 1.5).optional(),
      padY: em(0, 1.5).optional(),
    })
    .optional(),
};
const weightShips = (look: { font: BrandFontId; weight: number }) => brandFontHasWeight(look.font, look.weight);
const weightIssue = { message: "That weight is not one this font ships", path: ["weight"] };

/** What a kit style stores: the look without its name. */
export const textLookSchema = z.object(lookShape).refine(weightShips, weightIssue);

/** What a text overlay stores once a kit style was applied: the look plus the style's name (so the editor can show which one is on). */
export const textTreatmentSchema = z.object({ style: styleNameSchema, ...lookShape }).refine(weightShips, weightIssue);

export type TextTreatment = z.infer<typeof textTreatmentSchema>;
export type TextLook = z.infer<typeof textLookSchema>;
