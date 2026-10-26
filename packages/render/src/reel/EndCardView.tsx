import React from "react";
import { useVideoConfig } from "remotion";
import type { Timeline } from "@reelwalk/core";
import { ELEGANT_FONT_FAMILY } from "./look";
import { EndCardWithReveal } from "./toolbox/EndCards";

/**
 * The closing plate of a story cut (ADR 0065): a near-black card with one
 * line of the thin serif over the reel's last `endCard.durationMs`. Drawn
 * above every shot, title and card; the logo and watermark stay above it.
 * How it arrives is `endCard.reveal` (ADR 0082; absent is the hard cut).
 */
export const EndCardView: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const card = timeline.endCard;
  if (!card) return null;
  const reveal = card.reveal ?? "cut";
  const length = Math.min(durationInFrames, Math.max(1, Math.round((card.durationMs * fps) / 1000)));
  return <EndCardWithReveal text={card.text} reveal={reveal} length={length} fontFamily={ELEGANT_FONT_FAMILY} size={card.size} />;
};
