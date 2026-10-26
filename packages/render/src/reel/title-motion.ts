import type { CSSProperties } from "react";
import { letterSpacingEm, titleArrival, type TextOverlay, type TitleFont } from "@reelwalk/core";
import { ELEGANT_FADE_S } from "./look";
import { revealFrames, revealStyle, TITLE_REVEALS } from "./toolbox/title-reveal";

/**
 * Small pure pieces of TextView (ADR 0061), apart so they are tested without a browser.
 *
 *   titleFont(text, css): TitleFont
 *     the font the scene evaluator and the measurer see: the title's styled
 *     family, weight, size, tracking and stretch, and tabular figures for a
 *     count-up, which draws them (so the fit leaves room for the widest number).
 *
 *   textExit(text, frame, fps, durationInFrames): { scale, opacity, rise, chars }
 *     only the way out of a title's animation: word-by-word and from-behind type
 *     bring the words in themselves, but an elegant fade (or a chosen "fade")
 *     still fades them out over its last ELEGANT_FADE_S. Every other animation
 *     has no exit.
 */
export function titleFont(text: Pick<TextOverlay, "tracking" | "kinetic">, css: CSSProperties): TitleFont {
  return {
    fontFamily: String(css.fontFamily ?? ""), fontWeight: css.fontWeight as TitleFont["fontWeight"], fontSize: Number(css.fontSize) || 64, letterSpacing: text.tracking ?? letterSpacingEm(css.letterSpacing),
    fontStretch: css.fontStretch ? String(css.fontStretch) : undefined,
    ...(css.textTransform && css.textTransform !== "none" ? { textTransform: String(css.textTransform) } : {}),
    ...(text.kinetic?.preset === "count" ? { fontVariantNumeric: "tabular-nums" } : {}),
  };
}

export function textExit(text: Pick<TextOverlay, "animation" | "style">, frame: number, fps: number, durationInFrames: number): { scale: number; opacity: number; rise: number; chars: number | null } {
  const animation = titleArrival(text);
  const still = { scale: 1, opacity: 1, rise: 0, chars: null };
  // A toolbox reveal (the elegant serif's own track-in since ADR 0082) keeps only its way out: the words came in themselves.
  if ((TITLE_REVEALS as readonly string[]).includes(animation)) {
    const reveal = animation as (typeof TITLE_REVEALS)[number];
    if (frame < durationInFrames - revealFrames(reveal, fps, durationInFrames).exit) return still;
    return { ...still, opacity: revealStyle(reveal, frame, fps, durationInFrames).opacity };
  }
  if (animation !== "fade") return still;
  // The same length as the entrance fade's way out (textMotion's "fade").
  const fade = Math.max(1, Math.min(Math.round(ELEGANT_FADE_S * fps), Math.floor(durationInFrames / 2)));
  const from = durationInFrames - fade;
  return { ...still, opacity: Math.min(1, Math.max(0, 1 - (frame - from) / fade)) };
}
