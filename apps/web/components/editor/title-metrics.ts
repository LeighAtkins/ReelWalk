import { oneLineWidth, planarFitAndShift, type TextOverlay } from "@reelwalk/core";
import { textTreatmentCss } from "@reelwalk/render/reel";

/**
 * A title's size in composition terms, shared by the Pin sheet (moving a box
 * pin in from the frame edge) and the preview's handle (sizing its box to the
 * words), which each measured it themselves before ADR 0047.
 */

type Measured = Pick<TextOverlay, "text" | "style" | "color" | "size" | "font" | "tracking" | "shadow">;

/** How wide the title is on one line, as a fraction of the composition width (laid out in the DOM with its own font). */
export function titleLineWidth(text: Measured): number {
  const css = textTreatmentCss(text);
  return oneLineWidth(text.text, { fontFamily: String(css.fontFamily ?? ""), fontWeight: css.fontWeight, fontSize: Number(css.fontSize) || 64, letterSpacing: text.tracking, fontStretch: css.fontStretch ? String(css.fontStretch) : undefined });
}

/** How far to move a pinned title's centre so its line, warped onto the tracked plane, starts 3% inside both frame edges (composition fraction). */
export function planarShift(text: Measured, quad0: readonly number[]): number {
  return planarFitAndShift(quad0, titleLineWidth(text)).shift;
}

/** The scale a pinned title's line is drawn at on its plane (1 without a planar pin). */
export function pinnedLineFit(text: Measured & Pick<TextOverlay, "pin">): number {
  return text.pin?.quad ? planarFitAndShift(text.pin.quad, titleLineWidth(text)).fit : 1;
}
