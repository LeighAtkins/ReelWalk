import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Timeline } from "@reelwalk/core";
import { useFontsFor } from "./fonts";
import { fittedSize } from "./measure";
import { ELEGANT_FONT_FAMILY } from "./look";

/** The plate's ink and paper: near-black lacquer, the ivory of the facts card. */
const COLORS = { plate: "#0f0e0c", paper: "#f3ede2" };
/** Frames the plate takes to fade up over the last shot. */
const ENTER_FRAMES = 10;

const Plate: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const ready = useFontsFor(text, 600);
  // Its longest word fits the line (ADR 0083): the line wraps between words, never inside one.
  const fontSize = fittedSize({ text, unit: "word", fontFamily: ELEGANT_FONT_FAMILY, fontWeight: 600, letterSpacing: "0.08em", maxSize: 60, withinWidth: width * 0.8, ready });
  const shown = interpolate(frame, [0, ENTER_FRAMES], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const rise = interpolate(frame, [0, ENTER_FRAMES + 6], [12, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.plate, opacity: shown, justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          maxWidth: width * 0.8,
          textAlign: "center",
          fontFamily: ELEGANT_FONT_FAMILY,
          fontWeight: 600,
          fontSize,
          lineHeight: 1.25,
          letterSpacing: "0.08em",
          color: COLORS.paper,
          transform: `translateY(${rise}px)`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/**
 * The closing plate of a story cut (ADR 0065): a near-black card with one
 * line of the thin serif over the reel's last `endCard.durationMs`. Drawn
 * above every shot, title and card; the logo and watermark stay above it.
 */
export const EndCardView: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const card = timeline.endCard;
  if (!card) return null;
  const length = Math.min(durationInFrames, Math.max(1, Math.round((card.durationMs * fps) / 1000)));
  return (
    <Sequence from={durationInFrames - length} durationInFrames={length} name="end card">
      <Plate text={card.text} />
    </Sequence>
  );
};
