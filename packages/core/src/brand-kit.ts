/**
 * Brand kits (ADR 0078): a workspace's own fonts, palette and named text styles.
 *
 * A kit is data kept on the workspace (`Workspace.brandKit`, JSON). A style is a
 * recipe (a colour, a relative size, tracking and a `TextLook`: font, weight,
 * slant, hard shadow, plate) that an editor taps or an agent applies by name with
 * the `applyTextStyle` command. Applying copies the recipe onto the text
 * (`TextOverlay.brand` plus colour/size/tracking), so the saved reel carries
 * everything it needs: it renders the same without the kit, and editing the kit
 * later never re-styles reels already made.
 */
import { z } from "zod";
import { BRAND_FONT_IDS, styleNameSchema, textLookSchema, type TextTreatment } from "./brand-fonts";
import { fitTextSize, TEXT_SIZE_MAX, type TextOverlay } from "./timeline";

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);

export const paletteEntrySchema = z.object({
  /** Short name an agent can say: "magenta", "safety-yellow". */
  id: styleNameSchema,
  hex,
  /** Groups for the picker ("interface", "hero", "neon"). */
  group: z.string().trim().min(1).max(24).optional(),
  /** What it is for ("hard shadow of titles"). */
  note: z.string().trim().max(120).optional(),
});
export type PaletteEntry = z.infer<typeof paletteEntrySchema>;

export const brandStyleSchema = z.object({
  /** What `applyTextStyle` takes: `lastmile-title`. */
  name: styleNameSchema,
  /** What the Brand row shows. */
  label: z.string().trim().min(1).max(32),
  /** One line for an agent: when to use it. */
  description: z.string().trim().min(1).max(200),
  /** The words' colour. */
  color: hex,
  /** Scale relative to the default size (the text's own limits still apply). */
  size: z.number().min(0.3).max(TEXT_SIZE_MAX),
  tracking: z.number().min(-0.04).max(0.24).optional(),
  look: textLookSchema,
});
export type BrandStyle = z.infer<typeof brandStyleSchema>;

export const MAX_KIT_STYLES = 24;
export const MAX_KIT_PALETTE = 40;

export const brandKitSchema = z
  .object({
    /** `last-mile`. */
    id: styleNameSchema,
    name: z.string().trim().min(1).max(60),
    /** Bundled fonts the kit uses (and the text sheet may offer). */
    fonts: z.array(z.enum(BRAND_FONT_IDS)).min(1).max(BRAND_FONT_IDS.length),
    palette: z.array(paletteEntrySchema).max(MAX_KIT_PALETTE),
    styles: z.array(brandStyleSchema).min(1).max(MAX_KIT_STYLES),
  })
  .superRefine((kit, ctx) => {
    const seen = new Set<string>();
    kit.styles.forEach((style, index) => {
      if (seen.has(style.name)) ctx.addIssue({ code: "custom", message: `Two styles are called ${style.name}`, path: ["styles", index, "name"] });
      seen.add(style.name);
      if (!kit.fonts.includes(style.look.font)) ctx.addIssue({ code: "custom", message: `${style.name} uses ${style.look.font}, which the kit does not list in fonts`, path: ["styles", index, "look", "font"] });
    });
    const ids = new Set<string>();
    kit.palette.forEach((entry, index) => {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", message: `Two colours are called ${entry.id}`, path: ["palette", index, "id"] });
      ids.add(entry.id);
    });
  });
export type BrandKit = z.infer<typeof brandKitSchema>;

/** A kit as stored, or null when the column is empty or no longer valid (a bad kit never breaks the editor). */
export function readBrandKit(value: unknown): BrandKit | null {
  if (value === null || value === undefined) return null;
  const parsed = brandKitSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The fields a kit style writes onto a text. */
export type TextStylePatch = Pick<TextOverlay, "style" | "color" | "size" | "brand"> & Partial<Pick<TextOverlay, "tracking">>;

export type StyleResolution = { ok: true; patch: TextStylePatch; style: BrandStyle } | { ok: false; message: string };

/**
 * What applying kit style `name` writes onto a text. The style is looked up in this kit only; an unknown name is
 * refused with the names the kit has, so an agent can correct itself. Every kit style is set in the plain text
 * style (the kit's look replaces the style's own face, shadow and plate).
 */
export function resolveTextStyle(kit: BrandKit, name: string): StyleResolution {
  const style = kit.styles.find((entry) => entry.name === name);
  if (!style) return { ok: false, message: `The ${kit.name} kit has no style called ${name}. Its styles are: ${kit.styles.map((entry) => entry.name).join(", ")}.` };
  const brand: TextTreatment = { style: style.name, ...style.look };
  return {
    ok: true,
    style,
    patch: { style: "plain", color: style.color, size: fitTextSize("plain", style.size), ...(style.tracking !== undefined ? { tracking: style.tracking } : {}), brand },
  };
}

/** What an agent reads to discover a workspace's kit: styles with a plain description of each look, and the palette. */
export function describeBrandKit(kit: BrandKit) {
  return {
    id: kit.id,
    name: kit.name,
    fonts: kit.fonts,
    palette: kit.palette,
    styles: kit.styles.map((style) => ({ name: style.name, label: style.label, description: style.description, color: style.color, size: style.size, tracking: style.tracking ?? null, look: style.look })),
    use: "Apply a style with the applyTextStyle command: { type: 'applyTextStyle', textId, style: '<name>' }; style null takes the kit style off. Palette ids are for reading: colour values go in updateText's color as #rrggbb.",
  };
}
