import { Easing, interpolate } from "remotion";

/**
 * The quiet title reveals of the Remotion toolbox (ADR 0082), as pure functions of the title's own frame, so they are
 * tested without a browser and drawn the same in the editor's Player and the worker's export.
 *
 *   fadeQuick  a 200 ms fade in and out, no movement: the house hook, nearly a hard cut but without the pop.
 *   maskUp     the line rises into view through a hard edge under it over 6 frames (no fade), and drops back out the
 *              same way; the edge is the line's own box, so nothing outside it is clipped.
 *   trackIn    the letter-spacing closes from wide to the title's own over 0.8 s while it fades up (onda's TrackingIn,
 *              MIT, with its overdamped spring replaced by an ease-out so it never overshoots).
 *   blurIn     the whole line resolves out of an 8 px blur while it fades up and settles 12 px (onda's BlurReveal and
 *              remocn's soft-blur-in, MIT; one line, not per letter, so the serif never dances).
 *
 * Each returns the multipliers TextView applies on top of the title's style: opacity, a vertical offset in px at the
 * 1080-wide frame, extra letter-spacing in em, a CSS blur in px, and a clip-path inset for the mask. Exits are the
 * entrance reversed but quicker, so a title is gone on the cut it is held to.
 */
export const TITLE_REVEALS = ["fadeQuick", "maskUp", "trackIn", "blurIn"] as const;
export type TitleReveal = (typeof TITLE_REVEALS)[number];

export type RevealStyle = {
  opacity: number;
  /** px down from rest at 1080 wide (negative is up). */
  offsetY: number;
  /** em added to the title's letter-spacing. */
  trackingEm: number;
  /** CSS blur radius, px at 1080 wide. */
  blurPx: number;
  /** Fraction of the line's box hidden from the bottom by the mask (0 shows it all). */
  maskBottom: number;
};

export const REST: RevealStyle = { opacity: 1, offsetY: 0, trackingEm: 0, blurPx: 0, maskBottom: 0 };

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const easeIn = Easing.bezier(0.7, 0, 0.84, 0);

/** The entrance and exit lengths in frames for a reveal at `fps`, never more than a third of the title each. */
export function revealFrames(reveal: TitleReveal, fps: number, durationInFrames: number): { enter: number; exit: number } {
  const seconds: Record<TitleReveal, [number, number]> = {
    fadeQuick: [0.2, 0.2],
    maskUp: [6 / 30, 5 / 30],
    trackIn: [0.8, 0.25],
    blurIn: [0.6, 0.25],
  };
  const [enter, exit] = seconds[reveal];
  const cap = Math.max(1, Math.floor(durationInFrames / 3));
  return { enter: Math.max(1, Math.min(cap, Math.round(enter * fps))), exit: Math.max(1, Math.min(cap, Math.round(exit * fps))) };
}

/**
 * 0 before the entrance, 1 at rest, back to 0 at the end: how far "in" the title is at `frame`, with the entrance eased
 * out and the exit eased in.
 */
export function revealAmount(reveal: TitleReveal, frame: number, fps: number, durationInFrames: number): number {
  const { enter, exit } = revealFrames(reveal, fps, durationInFrames);
  // A fade is linear (an eased 6-frame fade reads as a flicker); every move eases out on the way in and in on the way out.
  const linear = reveal === "fadeQuick";
  const inAmount = interpolate(frame, [0, enter], [0, 1], { ...clamp, easing: linear ? Easing.linear : easeOut });
  const outAmount = interpolate(frame, [durationInFrames - exit, durationInFrames], [1, 0], { ...clamp, easing: linear ? Easing.linear : easeIn });
  return Math.min(inAmount, outAmount);
}

/** How the title is drawn at `frame` of its own `durationInFrames`. */
export function revealStyle(reveal: TitleReveal, frame: number, fps: number, durationInFrames: number, from: { trackingEm?: number; blurPx?: number; risePx?: number } = {}): RevealStyle {
  const a = revealAmount(reveal, frame, fps, durationInFrames);
  if (a >= 1) return REST;
  switch (reveal) {
    case "fadeQuick":
      return { ...REST, opacity: a };
    case "maskUp":
      // The line climbs its own height into a hard edge: fully hidden at 0, no fade at all.
      return { ...REST, offsetY: 0, maskBottom: 1 - a, opacity: a > 0 ? 1 : 0 };
    case "trackIn":
      return { ...REST, opacity: a, trackingEm: (from.trackingEm ?? 0.18) * (1 - a) };
    case "blurIn":
      return { ...REST, opacity: a, blurPx: (from.blurPx ?? 8) * (1 - a), offsetY: (from.risePx ?? 12) * (1 - a) };
  }
}

/**
 * The CSS for the mask reveal: the inner line is translated down by the hidden fraction of its own height and the
 * outer box clips to itself, so the type rises into view from a hard edge under it.
 */
export function maskCss(style: RevealStyle): { outer: { overflow?: "hidden" }; innerTranslatePct: number } {
  if (style.maskBottom <= 0) return { outer: {}, innerTranslatePct: 0 };
  return { outer: { overflow: "hidden" }, innerTranslatePct: Math.round(style.maskBottom * 1000) / 10 };
}
