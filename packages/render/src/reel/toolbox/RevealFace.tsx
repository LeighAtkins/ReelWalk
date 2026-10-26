import React from "react";
import { TITLE_REVEALS, maskCss, type RevealStyle, type TitleReveal } from "./title-reveal";

/** The toolbox reveals (ADR 0082) among a title's animations. */
export function isTitleReveal(animation: string): animation is TitleReveal {
  return (TITLE_REVEALS as readonly string[]).includes(animation);
}

/**
 * A screen title's face under a toolbox reveal (ADR 0082): the extra tracking on the face, the blur on the words, and
 * the mask (the words rise inside a box that clips to itself). Opacity and the settle are the composition's, through
 * textMotion. While the tracking is open, a wrapped title is drawn on the lines it has at rest (`lines`), so a wider
 * spacing never moves a word to the next line mid-reveal.
 */
export const RevealFace: React.FC<{ face: React.CSSProperties; text: string; reveal: RevealStyle; lines: string[] | null; masked: boolean }> = ({ face, text, reveal, lines, masked }) => {
  const base = face.letterSpacing === undefined ? "0em" : typeof face.letterSpacing === "number" ? `${face.letterSpacing}px` : face.letterSpacing;
  const tracking = reveal.trackingEm > 0.0005 ? { letterSpacing: `calc(${base} + ${reveal.trackingEm.toFixed(4)}em)` } : {};
  const blur = reveal.blurPx > 0.2 ? `blur(${reveal.blurPx.toFixed(2)}px)` : undefined;
  const filter = [face.filter, blur].filter(Boolean).join(" ") || undefined;
  const words = reveal.trackingEm > 0.0005 && lines && lines.length > 1 ? lines.join("\n") : text;
  const span = (
    <span style={{ ...face, ...tracking, ...(filter ? { filter } : {}), ...(words !== text ? { whiteSpace: "pre" as const } : {}) }}>{words}</span>
  );
  if (!masked) return span;
  // The mask's box is the same for the whole title (mounted the same way at rest, so nothing shifts when it opens),
  // padded so a serif's overhang and its soft shadow are not cut at rest, with the padding taken back by the margin.
  const mask = maskCss(reveal);
  return (
    <span style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", padding: "0.12em 0.3em", margin: "-0.12em -0.3em" }}>
      <span style={{ display: "inline-block", transform: mask.innerTranslatePct ? `translateY(${mask.innerTranslatePct}%)` : undefined }}>{span}</span>
    </span>
  );
};
