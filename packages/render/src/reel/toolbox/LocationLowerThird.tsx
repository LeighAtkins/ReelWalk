import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { TextOverlay } from "@reelwalk/core";
import { useFontsFor } from "../fonts";
import { ELEGANT_FONT_FAMILY } from "../look";

/**
 * The location lower third (ADR 0082): Remotion Elements' "Location Lower Third"
 * (remotion-dev/remotion, packages/docs/elements/overlays/location-lower-third, © Remotion, used under the Remotion
 * License's free tier, which covers a company of up to three people; see the ADR). Its motion is kept as written: the
 * pin drops 10 px and scales up while its outline draws itself and fills, the dot inside grows, then the line is
 * revealed from the left with an overdamped spring, and all of it leaves in reverse. Restyled to the house: the elegant
 * serif in white with a soft shadow, an ivory pin with a lacquer-black dot, no plate; and `cropRight` (an Interactive
 * prop) is a plain CSS clip-path, so the Player and the export draw it the same.
 *
 * A title with style "location" is drawn by this instead of TextView: `x`/`y` place the middle of the pin and the line,
 * `size` scales it, the text is the place.
 */
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const SPRING = Easing.spring({ damping: 200, mass: 1, stiffness: 100, allowTail: true, durationRestThreshold: 0.02, overshootClamping: false });
const OUT = Easing.out(Easing.cubic);
/** The Element's timings fit a clip of 72 frames or more; a shorter one plays them all faster, in proportion. */
const MIN_FRAMES = 72;
const COLORS = { pin: "#f3ede2", dot: "#0f0e0c", ink: "#ffffff" } as const;

export type LowerThirdFrame = {
  pinOpacity: number; pinY: number; pinScale: number; fillOpacity: number; dashOffset: number; dotR: number;
  /** Fraction of the line hidden from the right (1: none of it shows). */
  cropRight: number; textOpacity: number;
};

/** The Element's curves at `frame` of a lower third `durationInFrames` long. */
export function lowerThirdAt(frame: number, durationInFrames: number): LowerThirdFrame {
  const D = Math.max(2, durationInFrames);
  const k = Math.min(1, D / MIN_FRAMES);
  const at = (...keys: number[]) => keys.map((key) => (key >= 0 ? key * k : D + key * k));
  // Negative keys count back from the end, as the Element's `durationInFrames - n` do.
  return {
    pinOpacity: interpolate(frame, at(0, 9, -12, -1), [0, 1, 1, 0], clamp),
    pinY: interpolate(frame, at(0, 16, -14, -1), [-10, 0, 0, -8], { ...clamp, easing: OUT }),
    pinScale: interpolate(frame, at(0, 16, -14, -1), [0.88, 1, 1, 0.92], { ...clamp, easing: OUT }),
    fillOpacity: interpolate(frame, at(5, 18, -15, -6), [0, 1, 1, 0], clamp),
    dashOffset: interpolate(frame, at(0, 16, -15, -4), [1, 0, 0, 1], { ...clamp, easing: OUT }),
    dotR: interpolate(frame, at(10, 21, -18, -8), [0, 9, 9, 0], { ...clamp, easing: OUT }),
    cropRight: interpolate(frame, at(14, 38, -32, -12), [1, 0, 0, 1], { ...clamp, easing: [SPRING, Easing.linear, SPRING] }),
    textOpacity: interpolate(frame, at(14, 22, -22, -10), [0, 1, 1, 0], clamp),
  };
}

const PIN = "M32 3C15.4 3 4 15.4 4 31C4 50.8 22.1 69.6 29.3 76.2C30.8 77.6 33.2 77.6 34.7 76.2C41.9 69.6 60 50.8 60 31C60 15.4 48.6 3 32 3Z";

export const LocationLowerThird: React.FC<{ text: Pick<TextOverlay, "text" | "x" | "y" | "size"> }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  useFontsFor(text.text, 500);
  const f = lowerThirdAt(frame, durationInFrames);
  const scale = text.size || 1;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: text.x * width, top: text.y * height, transform: `translate(-50%, -50%) scale(${scale})`, display: "flex", alignItems: "center", gap: 26, whiteSpace: "nowrap" }}>
        <svg viewBox="0 0 64 80" width={64} height={80}
          style={{ overflow: "visible", flex: "none", filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.35))", opacity: f.pinOpacity, transform: `translateY(${f.pinY}px) scale(${f.pinScale})`, transformOrigin: "32px 78px" }}>
          <path d={PIN} pathLength={1} fill={COLORS.pin} fillOpacity={f.fillOpacity} stroke={COLORS.pin} strokeDasharray="1" strokeDashoffset={f.dashOffset} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} />
          <circle cx={32} cy={30} r={f.dotR} fill={COLORS.dot} />
        </svg>
        <div
          dir="auto"
          style={{
            fontFamily: ELEGANT_FONT_FAMILY, fontWeight: 500, fontSize: 54, letterSpacing: "0.01em", color: COLORS.ink,
            textShadow: "0 2px 14px rgba(0,0,0,0.4)", opacity: f.textOpacity,
            clipPath: `inset(-20% ${(f.cropRight * 100).toFixed(2)}% -20% -4%)`,
          }}
        >
          {text.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
