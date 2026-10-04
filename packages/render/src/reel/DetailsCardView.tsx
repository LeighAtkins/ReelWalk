import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { DETAILS_CARD_MS, detailFacts, hasDetails, INSTAGRAM, type ListingDetails, type Timeline } from "@reelwalk/core";
import { useFontsFor } from "./fonts";
import { REEL_FONT_FAMILY } from "./look";

const COLORS = { card: "rgba(11, 32, 54, 0.9)", paper: "#eaf2fb", muted: "#9cb7d3", signal: "#f0442c" };

/** Frames the card takes to arrive and to leave. */
const ENTER_FRAMES = 12;
const EXIT_FRAMES = 8;

const Card: React.FC<{ details: ListingDetails; local: number; length: number; leaves: boolean }> = ({ details, local, length, leaves }) => {
  const { fps, width, height } = useVideoConfig();
  const facts = detailFacts(details);
  useFontsFor([details.price, details.address, details.contact, ...facts].join(" "), 800);

  const enter = spring({ frame: local, fps, config: { damping: 16, stiffness: 140 }, durationInFrames: ENTER_FRAMES });
  const exit = leaves ? interpolate(local, [length - EXIT_FRAMES, length], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const safe = INSTAGRAM.safeZonePx;

  return (
    <div
      style={{
        position: "absolute",
        left: safe.left,
        width: width - safe.left - safe.right,
        // Sits just above the area Instagram covers with its caption.
        bottom: safe.bottom + 30,
        padding: "44px 48px",
        borderRadius: 30,
        backgroundColor: COLORS.card,
        borderLeft: `10px solid ${COLORS.signal}`,
        color: COLORS.paper,
        fontFamily: REEL_FONT_FAMILY,
        opacity: Math.min(enter, exit),
        transform: `translateY(${interpolate(enter, [0, 1], [height * 0.04, 0])}px)`,
        display: "grid",
        gap: 18,
      }}
    >
      {details.price ? (
        <div style={{ fontSize: 96, lineHeight: 1, fontWeight: 850, fontStretch: "110%", letterSpacing: "-0.01em" }}>{details.price}</div>
      ) : null}
      {facts.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 28px", fontSize: 52, fontWeight: 700, fontStretch: "80%" }}>
          {facts.map((fact, index) => (
            <span key={fact} style={{ display: "flex", alignItems: "center", gap: 28 }}>
              {index > 0 ? <span style={{ width: 4, height: 40, backgroundColor: COLORS.signal }} /> : null}
              {fact}
            </span>
          ))}
        </div>
      ) : null}
      {details.address ? <div style={{ fontSize: 40, lineHeight: 1.2, fontWeight: 500, color: COLORS.muted }}>{details.address}</div> : null}
      {details.contact ? <div style={{ fontSize: 40, lineHeight: 1.2, fontWeight: 700 }}>{details.contact}</div> : null}
    </div>
  );
};

/**
 * Price, rooms and contact as a card over the start or the end of the reel
 * (or both). It sits above Instagram's caption area.
 */
export const DetailsCardView: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const details = timeline.details;
  if (!hasDetails(details)) return null;

  // Never more than 40% of a short reel.
  const length = Math.min(Math.round((DETAILS_CARD_MS * fps) / 1000), Math.floor(durationInFrames * 0.4));
  if (length < 10) return null;

  const atStart = details.placement !== "end" && frame < length;
  const atEnd = details.placement !== "start" && frame >= durationInFrames - length;
  if (atStart) return <Card details={details} local={frame} length={length} leaves />;
  if (atEnd) return <Card details={details} local={frame - (durationInFrames - length)} length={length} leaves={false} />;
  return null;
};
