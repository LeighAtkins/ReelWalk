import React from "react";
import { AbsoluteFill } from "remotion";
import { INSTAGRAM } from "@reelwalk/core";
import { useFontsFor } from "./fonts";

const LABEL = "Made with ReelWalk";

/**
 * The mark on free-plan exports: small, in the lower right, just above the
 * strip Instagram covers with its own controls, so it stays readable in the
 * feed without sitting on the picture's subject.
 */
export const Watermark: React.FC = () => {
  useFontsFor(LABEL, 800);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          right: INSTAGRAM.safeZonePx.right,
          bottom: INSTAGRAM.safeZonePx.bottom + 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 18px 10px 14px",
          borderRadius: 999,
          background: "rgba(11, 32, 54, 0.55)",
          color: "#fff",
          fontFamily: '"Archivo Variable", system-ui, sans-serif',
          fontStretch: "125%",
          fontWeight: 800,
          fontSize: 30,
          letterSpacing: "0.01em",
          opacity: 0.9,
        }}
      >
        <span style={{ width: 14, height: 14, borderRadius: 999, background: "#c1272d" }} />
        {LABEL}
      </div>
    </AbsoluteFill>
  );
};
