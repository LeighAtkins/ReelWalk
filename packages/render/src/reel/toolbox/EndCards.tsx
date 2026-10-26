import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { EndCardReveal } from "@reelwalk/core";
import { useFontsFor } from "../fonts";
import { fittedSize } from "../measure";
import { LightLeakOverlay } from "./LightLeak";
import { revealStyle } from "./title-reveal";

/**
 * The end card (ADR 0065 card, ADR 0082 reveals): a near-black plate with the line in small tracked capitals. The
 * owner kept two ways in (2026-10-26):
 *
 *   cut    the plate is simply there on the cut: the measured luxury close (5 of 14 reels end on a logo card with no
 *          move). The default, and what a card saved with ADR 0065's fade (or the gallery's "over") now reads as.
 *   leak   a soft warm glint over the last shot and, at its brightest, the plate is under it; the line resolves as the
 *          light retracts.
 */
export const END_CARD_COLORS = { plate: "#0f0e0c", paper: "#f3ede2" } as const;
/** Frames of glint before the card, and how long it runs in all: it peaks on the card's first frame and is gone 6 frames into it. */
export const LEAK_LEAD_FRAMES = 8;
export const LEAK_FRAMES = 16;
/** The line's size, weight and tracking: small tracked capitals. */
const CAPS = { maxSize: 46, weight: 500, tracking: "0.24em" } as const;
/** A card sized like a title (ADR 0087, `endCard.size`): the elegant face's px per size step, heavier, lightly tracked. */
const TITLE_CAPS = { pxPerSize: 76 * 0.7, weight: 600, tracking: "0.08em" } as const;

/** Whether the line is still resolving at the card's own `frame` (the leak's blur-in starts 4 frames after the plate). */
export function lineReveal(reveal: EndCardReveal, frame: number, fps: number) {
  return reveal === "leak" ? revealStyle("blurIn", Math.max(0, frame - 4), fps, 10 * fps) : null;
}

export const EndCardPlate: React.FC<{ text: string; reveal: EndCardReveal; fontFamily: string; size?: number }> = ({ text, reveal, fontFamily, size }) => {
  const frame = useCurrentFrame();
  const { width, fps } = useVideoConfig();
  const caps = size ? { maxSize: TITLE_CAPS.pxPerSize * size, weight: TITLE_CAPS.weight, tracking: TITLE_CAPS.tracking } : CAPS;
  const ready = useFontsFor(text, caps.weight);
  // Its longest word fits the line (ADR 0083): the line wraps between words, never inside one. Capitals are measured as drawn.
  const fontSize = fittedSize({ text: text.toUpperCase(), unit: "word", fontFamily, fontWeight: caps.weight, letterSpacing: caps.tracking, maxSize: caps.maxSize, withinWidth: width * 0.8, ready });
  const line = lineReveal(reveal, frame, fps);
  return (
    <AbsoluteFill style={{ backgroundColor: END_CARD_COLORS.plate, justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          maxWidth: width * 0.8,
          textAlign: "center",
          fontFamily,
          fontWeight: caps.weight,
          fontSize,
          lineHeight: 1.25,
          letterSpacing: caps.tracking,
          textTransform: "uppercase",
          color: END_CARD_COLORS.paper,
          transform: line?.offsetY ? `translateY(${line.offsetY}px)` : undefined,
          opacity: line ? line.opacity : 1,
          filter: line && line.blurPx > 0.2 ? `blur(${line.blurPx.toFixed(2)}px)` : undefined,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/**
 * The card and, for "leak", its glint, placed at the end of a composition of `durationInFrames`: the card covers the
 * last `length` frames; the glint starts LEAK_LEAD_FRAMES before it so it is at its brightest on the card's first frame.
 */
export const EndCardWithReveal: React.FC<{ text: string; reveal: EndCardReveal; length: number; fontFamily: string; size?: number }> = ({ text, reveal, length, fontFamily, size }) => {
  const { durationInFrames } = useVideoConfig();
  const from = durationInFrames - length;
  const leakFrom = Math.max(0, from - LEAK_LEAD_FRAMES);
  return (
    <>
      <Sequence from={from} durationInFrames={length} name="end card">
        <EndCardPlate text={text} reveal={reveal} fontFamily={fontFamily} size={size} />
      </Sequence>
      {reveal === "leak" ? (
        <Sequence from={leakFrom} durationInFrames={Math.min(LEAK_FRAMES, durationInFrames - leakFrom)} name="end card light">
          <LightLeakOverlay seed={7} />
        </Sequence>
      ) : null}
    </>
  );
};
