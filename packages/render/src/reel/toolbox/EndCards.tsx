import React from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { EndCardReveal } from "@reelwalk/core";
import { useFontsFor } from "../fonts";
import { fittedSize } from "../measure";
import { LightLeakOverlay } from "./LightLeak";
import { revealStyle } from "./title-reveal";

/**
 * The end card's reveals (ADR 0065 card, ADR 0082 reveals). The text and the plate's colours are the card's; only the
 * way it arrives differs:
 *
 *   fade   the plate fades up over 10 frames and the line rises 12 px (ADR 0065, every saved card).
 *   cut    the plate is simply there on the cut, the line in small tracked capitals: the measured luxury close (5 of 14
 *          reels end on a logo card with no move).
 *   over   no plate: the line resolves out of a blur over the last shot, with the bottom of the frame darkened enough
 *          to hold white type. For a final wide that is itself the ending.
 *   leak   a warm light leak washes over the last shot and, at its brightest, the plate is under it; the line
 *          resolves as the light retracts.
 */
export const END_CARD_COLORS = { plate: "#0f0e0c", paper: "#f3ede2" } as const;
/** Frames the plate takes to fade up over the last shot (the "fade" reveal). */
export const ENTER_FRAMES = 10;
/** Frames of light leak before the card, and how long it runs in all (it peaks on the card's first frame). */
export const LEAK_LEAD_FRAMES = 12;
export const LEAK_FRAMES = 30;

/** The plate's opacity at the card's own `frame` for a reveal. */
export function plateOpacity(reveal: EndCardReveal, frame: number): number {
  switch (reveal) {
    case "fade":
      return interpolate(frame, [0, ENTER_FRAMES], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    case "over":
      return 0;
    default:
      return 1;
  }
}

export const EndCardPlate: React.FC<{ text: string; reveal: EndCardReveal; fontFamily: string }> = ({ text, reveal, fontFamily }) => {
  const frame = useCurrentFrame();
  const { width, fps, durationInFrames } = useVideoConfig();
  const plate = plateOpacity(reveal, frame);
  const caps = reveal === "cut" || reveal === "leak";
  const weight = caps ? 500 : 600, tracking = caps ? "0.24em" : "0.08em";
  const ready = useFontsFor(text, weight);
  // Its longest word fits the line (ADR 0083): the line wraps between words, never inside one. Capitals are measured as drawn.
  const fontSize = fittedSize({ text: caps ? text.toUpperCase() : text, unit: "word", fontFamily, fontWeight: weight, letterSpacing: tracking, maxSize: caps ? 46 : 60, withinWidth: width * 0.8, ready });
  // The line: the ADR 0065 rise for "fade", a blur resolve (held, no exit) for "over" and "leak", nothing for "cut".
  const blur = reveal === "over" || reveal === "leak" ? revealStyle("blurIn", Math.max(0, frame - (reveal === "leak" ? 4 : 0)), fps, Math.max(durationInFrames * 3, 60)) : null;
  const rise = reveal === "fade" ? interpolate(frame, [0, ENTER_FRAMES + 6], [12, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : blur?.offsetY ?? 0;
  return (
    <AbsoluteFill style={{ justifyContent: reveal === "over" ? "flex-end" : "center", alignItems: "center", opacity: reveal === "fade" ? plate : 1 }}>
      {reveal === "over" ? (
        <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(10,9,8,0.62) 0%, rgba(10,9,8,0.38) 34%, rgba(10,9,8,0) 60%)", opacity: blur?.opacity ?? 1 }} />
      ) : (
        <AbsoluteFill style={{ backgroundColor: END_CARD_COLORS.plate, opacity: reveal === "fade" ? 1 : plate }} />
      )}
      <div
        style={{
          position: "relative",
          maxWidth: width * 0.8,
          marginBottom: reveal === "over" ? "34%" : 0,
          textAlign: "center",
          fontFamily,
          fontWeight: weight,
          fontSize,
          lineHeight: 1.25,
          letterSpacing: tracking,
          textTransform: caps ? "uppercase" : undefined,
          color: END_CARD_COLORS.paper,
          transform: rise ? `translateY(${rise}px)` : undefined,
          opacity: blur ? blur.opacity : 1,
          filter: blur && blur.blurPx > 0.2 ? `blur(${blur.blurPx.toFixed(2)}px)` : undefined,
          textShadow: reveal === "over" ? "0 2px 18px rgba(0,0,0,0.45)" : undefined,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/**
 * The card and, for "leak", its light, placed at the end of a composition of `durationInFrames`: the card covers the
 * last `length` frames; the leak starts LEAK_LEAD_FRAMES before it so it is at its brightest on the card's first frame.
 */
export const EndCardWithReveal: React.FC<{ text: string; reveal: EndCardReveal; length: number; fontFamily: string }> = ({ text, reveal, length, fontFamily }) => {
  const { durationInFrames } = useVideoConfig();
  const from = durationInFrames - length;
  const leakFrom = Math.max(0, from - LEAK_LEAD_FRAMES);
  return (
    <>
      <Sequence from={from} durationInFrames={length} name="end card">
        <EndCardPlate text={text} reveal={reveal} fontFamily={fontFamily} />
      </Sequence>
      {reveal === "leak" ? (
        <Sequence from={leakFrom} durationInFrames={Math.min(LEAK_FRAMES, durationInFrames - leakFrom)} name="end card light">
          <LightLeakOverlay seed={7} />
        </Sequence>
      ) : null}
    </>
  );
};
