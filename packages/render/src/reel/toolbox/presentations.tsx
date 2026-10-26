import React from "react";
import { AbsoluteFill, Easing, interpolate } from "remotion";
import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";

/**
 * The CSS transition presentations the Remotion toolbox adopts (ADR 0082), for Remotion's TransitionSeries. CSS only,
 * so the editor's Player on a phone draws exactly what the worker exports (the shader transitions in
 * @remotion/transitions draw through HTML-in-canvas, which phone browsers lack; see the ADR's gallery).
 *
 *   softDissolve  a crossfade with a 3 % breath of scale: the outgoing shot grows a touch as it goes, the incoming one
 *                 settles from slightly small. From onda's `morph` (github.com/degueba/onda, MIT, © 2026 Rodrigo
 *                 Botelho), with the scale reduced from 4 % for footage that already moves.
 *   focusPull     a rack focus: the outgoing shot blurs and brightens a little and lets go, the incoming one resolves
 *                 out of the same blur. From remocn's `focus-pull` (github.com/kapishdima/remocn, MIT, © 2026 Remocn),
 *                 blur and lift reduced for property footage.
 */
type Props = TransitionPresentationComponentProps<Record<string, unknown>>;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** How much larger the outgoing shot grows, and how much smaller the incoming one starts, in a soft dissolve. */
export const SOFT_DISSOLVE_SCALE = 0.03;

export function softDissolveStyle(direction: "entering" | "exiting", progress: number): { opacity: number; scale: number } {
  const p = Math.min(1, Math.max(0, progress));
  return direction === "entering"
    ? { opacity: p, scale: 1 - SOFT_DISSOLVE_SCALE + SOFT_DISSOLVE_SCALE * p }
    : { opacity: 1 - p, scale: 1 + SOFT_DISSOLVE_SCALE * p };
}

const SoftDissolve: React.FC<Props> = ({ presentationDirection, presentationProgress, children }) => {
  const { opacity, scale } = softDissolveStyle(presentationDirection, presentationProgress);
  return <AbsoluteFill style={{ opacity, transform: scale === 1 ? undefined : `scale(${scale})` }}>{children}</AbsoluteFill>;
};

export function softDissolve(): TransitionPresentation<Record<string, unknown>> {
  return { component: SoftDissolve, props: {} };
}

/** The focus pull's blur at its widest, px at 1080 wide, and its brightness lift. */
export const FOCUS_PULL_BLUR = 12;
const FOCUS_PULL_LIFT = 0.15;

export function focusPullStyle(direction: "entering" | "exiting", progress: number): { opacity: number; scale: number; blur: number; brightness: number } {
  const p = Math.min(1, Math.max(0, progress));
  const ease = Easing.bezier(0.42, 0, 0.58, 1);
  if (direction === "exiting") {
    return {
      opacity: interpolate(p, [0.42, 0.68], [1, 0], { ...clamp, easing: ease }),
      scale: interpolate(p, [0, 0.6], [1, 1.03], { ...clamp, easing: ease }),
      blur: interpolate(p, [0.05, 0.55], [0, FOCUS_PULL_BLUR], { ...clamp, easing: Easing.in(Easing.quad) }),
      brightness: interpolate(p, [0.1, 0.55], [1, 1 + FOCUS_PULL_LIFT], clamp),
    };
  }
  return {
    opacity: interpolate(p, [0.32, 0.52], [0, 1], clamp),
    scale: interpolate(p, [0.35, 1], [0.985, 1], { ...clamp, easing: Easing.out(Easing.cubic) }),
    blur: interpolate(p, [0.35, 0.9], [FOCUS_PULL_BLUR, 0], { ...clamp, easing: Easing.out(Easing.quad) }),
    brightness: interpolate(p, [0.4, 0.85], [1 + FOCUS_PULL_LIFT, 1], clamp),
  };
}

const FocusPull: React.FC<Props> = ({ presentationDirection, presentationProgress, children }) => {
  const s = focusPullStyle(presentationDirection, presentationProgress);
  const filter = s.blur > 0.2 || s.brightness !== 1 ? `blur(${s.blur.toFixed(2)}px) brightness(${s.brightness.toFixed(3)})` : undefined;
  return <AbsoluteFill style={{ opacity: s.opacity, transform: s.scale === 1 ? undefined : `scale(${s.scale})`, filter }}>{children}</AbsoluteFill>;
};

export function focusPull(): TransitionPresentation<Record<string, unknown>> {
  return { component: FocusPull, props: {} };
}
