import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { clipDurationMs, HOOK_FONT_FAMILIES, type Clip, type Hook, type Timeline } from "@reelwalk/core";
import { PersonMatteView } from "./PersonMatte";
import type { ReelAsset } from "./types";

/**
 * Visual hooks (ADR 0041): the first two seconds that stop the scroll.
 * Drawn above the clips and text for `hook.durationMs`, then gone.
 *
 * - alert: a phone-style system alert with the listing's line on it.
 * - spotlight: a flat colour field with only the person cut out of the
 *   first shot, then the colour irises away to the room.
 * - device: the reel plays inside a phone on a dark field, and the phone
 *   grows until its screen is the whole frame.
 */

const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

export const HookView: React.FC<{ timeline: Timeline; hook: Hook; firstClip: Clip | undefined; asset: ReelAsset | undefined }> = ({ hook, firstClip, asset }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const total = Math.round((hook.durationMs * fps) / 1000);
  if (frame >= total) return null;
  const t = frame / total;
  const inFrames = Math.round(fps * 0.3), outFrames = Math.round(fps * 0.45);
  const entering = ease(frame / inFrames);
  const leaving = ease((total - frame) / outFrames);
  const font = HOOK_FONT_FAMILIES[hook.font];

  if (hook.kind === "alert") {
    const pop = interpolate(entering, [0, 1], [0.86, 1]);
    const alpha = Math.min(entering, leaving);
    return (
      <AbsoluteFill style={{ pointerEvents: "none", alignItems: "center", justifyContent: "center", background: `rgba(0,0,0,${0.28 * alpha})` }}>
        <div style={{
          width: width * 0.68, borderRadius: width * 0.032, overflow: "hidden", transform: `scale(${pop})`, opacity: alpha,
          background: "rgba(250,250,250,0.92)", backdropFilter: "blur(24px)", color: "#111", fontFamily: font, textAlign: "center",
          boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
        }}>
          <div style={{ padding: `${width * 0.05}px ${width * 0.05}px ${width * 0.04}px` }}>
            <div style={{ fontSize: width * 0.046, fontWeight: 700, letterSpacing: "-0.01em" }}>{hook.title || "New listing"}</div>
            {hook.body ? <div style={{ fontSize: width * 0.034, marginTop: width * 0.012, lineHeight: 1.3, color: "#333" }}>{hook.body}</div> : null}
          </div>
          <div style={{ display: "flex", borderTop: "1px solid rgba(0,0,0,0.14)" }}>
            <div style={{ flex: 1, padding: `${width * 0.03}px 0`, fontSize: width * 0.04, color: "#0a66ff", borderRight: "1px solid rgba(0,0,0,0.14)" }}>Not now</div>
            <div style={{ flex: 1, padding: `${width * 0.03}px 0`, fontSize: width * 0.04, color: "#0a66ff", fontWeight: 700 }}>{hook.action || "See inside"}</div>
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  if (hook.kind === "spotlight") {
    // The colour leaves as an iris from the centre over the last half second; the person matte rides on it.
    const radius = interpolate(leaving, [0, 1], [0, 1.2]);
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div style={{ position: "absolute", inset: 0, clipPath: `circle(${radius * 100}% at 50% 50%)` }}>
          <div style={{ position: "absolute", inset: 0, background: hook.color }} />
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 45%, rgba(255,255,255,0.18), rgba(0,0,0,0.25) 70%)` }} />
          {firstClip && asset && asset.kind === "VIDEO" ? <PersonMatteView clip={firstClip} asset={asset} durationInFrames={Math.max(1, Math.round((clipDurationMs(firstClip) * fps) / 1000))} /> : null}
          {hook.title ? (
            <div style={{ position: "absolute", left: 0, right: 0, top: height * 0.12, textAlign: "center", fontFamily: font, fontWeight: 800, fontSize: width * 0.13, lineHeight: 0.95, color: "#fff", letterSpacing: "-0.02em", textShadow: "0 8px 40px rgba(0,0,0,0.35)", opacity: entering, transform: `translateY(${(1 - entering) * 30}px)`, padding: `0 ${width * 0.06}px`, whiteSpace: "pre-line" }}>{hook.title}</div>
          ) : null}
        </div>
      </AbsoluteFill>
    );
  }

  // device: a dark field with a phone-shaped window onto the footage, growing to the full frame.
  const grow = ease(interpolate(t, [0.35, 1], [0, 1]));
  const screenW = interpolate(grow, [0, 1], [width * 0.6, width]);
  const screenH = interpolate(grow, [0, 1], [width * 0.6 * (19.5 / 9), height]);
  const radius = interpolate(grow, [0, 1], [width * 0.07, 0]);
  const tilt = interpolate(grow, [0, 1], [-5, 0]);
  const bezel = interpolate(grow, [0, 1], [width * 0.012, 0]);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <div style={{
        width: screenW, height: screenH, borderRadius: radius, transform: `rotate(${tilt}deg)`,
        boxShadow: `0 0 0 ${bezel}px #0b0b0b, 0 0 0 ${width * 3}px #0b0b0b, 0 40px 90px rgba(0,0,0,0.6)`,
        position: "relative",
      }}>
        {bezel > 0.5 ? <div style={{ position: "absolute", top: screenH * 0.012, left: "50%", transform: "translateX(-50%)", width: screenW * 0.3, height: screenH * 0.028, borderRadius: 999, background: "#0b0b0b" }} /> : null}
      </div>
      {hook.title ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: height * 0.1, textAlign: "center", fontFamily: font, fontWeight: 700, fontSize: width * 0.05, color: "#fff", opacity: Math.min(entering, 1 - grow), padding: `0 ${width * 0.08}px` }}>{hook.title}</div>
      ) : null}
    </AbsoluteFill>
  );
};
