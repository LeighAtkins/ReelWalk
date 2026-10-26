/**
 * Hook legibility (ADR 0087, owner's review of v1: "Live above it all" was tiny, thin and low contrast on the sky).
 * The opening line must reach 4.5:1 against what is measured under it, counting the halo its shadow lays down, or it
 * is refused. Pure arithmetic on a CriticFrame (gamma luma) and a box in frame fractions.
 *
 * The shadow model: the renderer's shadows (render look.ts `textContrastCss`) put a dark halo around every stroke, so
 * the light the letter edges stand against is the background darkened by roughly this share. The strong shadow (a dense
 * halo and a stroke) darkens most; "auto" on the elegant style is its faint glow.
 */
import { regionLuminance, colorLuminance, contrastRatio, type CriticBox, type CriticFrame } from "./critic";
import type { TextOverlay } from "./timeline";

export const HOOK_CONTRAST_MIN = 4.5;
export const SHADOW_DARKEN: Record<NonNullable<TextOverlay["shadow"]>, number> = { none: 0, auto: 0.2, soft: 0.35, strong: 0.6 };

/** The hook's type (owner, 2026-10-26): Playfair 600 with capitals 4.5–5.5 % of the frame height. */
export const HOOK_TYPE = { style: "elegant", weight: 600, size: 2.45, shadow: "strong" } as const;

/**
 * The contrast a title has over `bg` (linear luminance of the region under it), in the worst tenth: light ink against
 * the brightest tenth darkened by the halo, dark ink against the darkest tenth.
 */
export function titleContrast(color: string, bg: { p10: number; p90: number }, shadow: TextOverlay["shadow"] = "auto"): number {
  const ink = colorLuminance(color);
  const light = ink > 0.4;
  const darken = SHADOW_DARKEN[shadow ?? "auto"];
  return light ? contrastRatio(ink, bg.p90 * (1 - darken)) : contrastRatio(ink, bg.p10);
}

/** How busy the region is: the spread of its middle 80 % (0 flat sky, high a lattice of branches). */
export function regionBusy(bg: { p10: number; p90: number }): number {
  return bg.p90 - bg.p10;
}

export type TitleSpot = { y: number; color: "#ffffff" | "#111111"; shadow: "strong" | "soft"; contrast: number; busy: number };

/**
 * Where the hook can sit over `frame`: each candidate height inside the top 30 % (above Instagram's header band, clear
 * of the centre) is tried with white ink and a strong shadow, then near-black ink with a soft one; the calmest spot
 * that reaches 4.5:1 wins. Null when none does (the caller then refuses the placement).
 */
export function pickTitleSpot(frame: CriticFrame, size: { w: number; h: number }, ys: readonly number[] = [0.13, 0.16, 0.19, 0.22, 0.25, 0.28]): TitleSpot | null {
  const spots: TitleSpot[] = [];
  for (const y of ys) {
    const box: CriticBox = { x: 0.5 - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h };
    const bg = regionLuminance(frame, box);
    if (!bg) continue;
    for (const [color, shadow] of [["#ffffff", "strong"], ["#111111", "soft"]] as const) {
      const contrast = titleContrast(color, bg, shadow);
      if (contrast >= HOOK_CONTRAST_MIN) spots.push({ y, color, shadow, contrast: Math.round(contrast * 100) / 100, busy: regionBusy(bg) });
    }
  }
  // Calm first (a busy background breaks the letters even at contrast), white before dark (the house ink), then contrast.
  const calm = (spot: TitleSpot) => Math.round(spot.busy * 10);
  const ink = (spot: TitleSpot) => (spot.color === "#ffffff" ? 0 : 1);
  spots.sort((a, b) => calm(a) - calm(b) || ink(a) - ink(b) || b.contrast - a.contrast);
  return spots[0] ?? null;
}

/** The measured contrast of a title over `frame` at `box`, or null when the box is off the frame. */
export function measuredContrast(frame: CriticFrame, box: CriticBox, text: Pick<TextOverlay, "color" | "shadow">): number | null {
  const bg = regionLuminance(frame, box);
  return bg ? Math.round(titleContrast(text.color, bg, text.shadow) * 100) / 100 : null;
}
