import React from "react";
import { lightLeak } from "@remotion/effects/light-leak";
import { AbsoluteFill, interpolate, Solid, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * A warm light leak over a cut (ADR 0082): Remotion's own `lightLeak()` effect (@remotion/effects, WebGL2) on a
 * full-frame solid, its progress run once from 0 to 1 over the overlay's sequence, screened over the footage so it
 * only ever adds light. It reveals in the first half and retracts in the second; centred on a hard cut it hides the
 * cut at its brightest. `hueShift` 0 is the yellow-to-orange of late sun.
 *
 * Where the browser has no WebGL2 (an old phone's Player) the effect draws nothing and the cut is a plain cut, which
 * is the house default anyway.
 */
export const LightLeakOverlay: React.FC<{ seed?: number; hueShift?: number; strength?: number }> = ({ seed = 3, hueShift = 0, strength = 0.85 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const sequenceFrames = Math.max(2, durationInFrames);
  return (
    <AbsoluteFill style={{ mixBlendMode: "screen", opacity: strength, pointerEvents: "none" }}>
      <Solid
        width={width}
        height={height}
        color="#000000"
        effects={[lightLeak({ seed, hueShift, progress: interpolate(frame, [0, sequenceFrames - 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) })]}
      />
    </AbsoluteFill>
  );
};
