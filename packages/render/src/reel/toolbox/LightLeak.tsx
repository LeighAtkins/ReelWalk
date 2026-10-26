import React from "react";
import { lightLeak } from "@remotion/effects/light-leak";
import { AbsoluteFill, interpolate, Solid, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * The effect's progress at `frame`: it reveals up to 0.5 and retracts after. A glint does not open all the way: it
 * runs up to `peak` × 0.5 and back down the same way (peak 1 is the effect's full sweep, 0 to 1).
 */
export function leakProgress(frame: number, frames: number, peak: number): number {
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  if (peak >= 1) return interpolate(frame, [0, frames - 1], [0, 1], clamp);
  const mid = (frames - 1) / 2;
  return interpolate(frame, [0, mid, frames - 1], [0, 0.5 * peak, 0], clamp);
}

export type LightLeakLook = { strength: number; hueShift: number; saturation: number; peak: number };
/**
 * Toned down after the owner's review (2026-10-26: "a glint, not a yellow wash"), chosen from rendered variants on the
 * owner's footage: 40 % strength, opened only three quarters of the way so it is a streak at one edge rather than a
 * full-frame wash, its hue turned 12° from the effect's yellow to amber (30° is already rust; a negative turn goes green), a little colour taken out.
 */
export const LIGHT_LEAK_LOOK: LightLeakLook = { strength: 0.4, hueShift: 12, saturation: 0.85, peak: 0.75 };

/**
 * A soft warm glint over a cut (ADR 0082): Remotion's own `lightLeak()` effect (@remotion/effects, WebGL2) on a
 * full-frame solid, screened over the footage so it only ever adds light, at its brightest on the hard cut it hides.
 * Where the browser has no WebGL2 (an old phone's Player) the effect draws nothing and the cut is a plain cut, which is
 * the house default anyway.
 */
export const LightLeakOverlay: React.FC<{ seed?: number; look?: LightLeakLook }> = ({ seed = 3, look = LIGHT_LEAK_LOOK }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const sequenceFrames = Math.max(2, durationInFrames);
  return (
    <AbsoluteFill style={{ mixBlendMode: "screen", opacity: look.strength, filter: look.saturation === 1 ? undefined : `saturate(${look.saturation})`, pointerEvents: "none" }}>
      <Solid
        width={width}
        height={height}
        color="#000000"
        effects={[lightLeak({ seed, hueShift: look.hueShift, progress: leakProgress(frame, sequenceFrames, look.peak) })]}
      />
    </AbsoluteFill>
  );
};
