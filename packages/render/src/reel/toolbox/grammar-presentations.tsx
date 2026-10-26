import React from "react";
import { AbsoluteFill, Easing, interpolate } from "remotion";
import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import type { CutIn, DepthGrid } from "@reelwalk/core";
import { focusPullStyle } from "./presentations";

/**
 * The cut grammar's drawn techniques (ADR 0087), as CSS presentations for Remotion's TransitionSeries, so the editor's
 * Player on a phone draws what the worker exports (no canvas effects, no WebGL):
 *
 *   occlusionWipe  the incoming shot is revealed behind a soft edge that follows the occluder the planner found (a
 *                  door frame, a wall edge, a person), from the side it enters; a CSS gradient mask
 *   zoomThrough    the outgoing shot pushes into a region (a window, a doorway, where the eye is) and lets go; the
 *                  incoming shot settles out of the matching region; CSS transforms with a little blur for speed
 *   depthFocus     the focus pull racking through depth: a blur overlay masked by the depth map (far first on the way
 *                  out, near first on the way in) under the focus pull's own whole-frame blur; backdrop-filter with
 *                  an SVG mask, the same technique as `lensSoftness`
 */
type Wipe = NonNullable<CutIn["wipe"]>;
type Zoom = NonNullable<CutIn["zoom"]>;
type Props<T> = TransitionPresentationComponentProps<T & Record<string, unknown>>;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// ── Occlusion wipe ──────────────────────────────────────────────

/** The edge position (0 at the side it enters from, 1 across the frame) at `progress`, guaranteed to start off-frame and finish across it. */
export function wipeEdgeAt(wipe: Wipe, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const steps = wipe.edge.length - 1;
  const at = p * steps, i = Math.min(steps - 1, Math.floor(at)), f = at - i;
  const followed = wipe.edge[i] + (wipe.edge[i + 1] - wipe.edge[i]) * f;
  // The measured edge may not cross the whole frame inside the transition: it is followed, then completed.
  const soft = wipe.soft ?? 0.06;
  const span = -soft + (1 + 2 * soft) * Math.min(1, Math.max(0, followed));
  const finish = interpolate(p, [0.7, 1], [0, 1], { ...clamp, easing: Easing.inOut(Easing.quad) });
  const start = interpolate(p, [0, 0.15], [1, 0], clamp);
  return (span * (1 - finish) + (1 + soft) * finish) * (1 - start) + -soft * start;
}

const GRADIENT_TO: Record<Wipe["from"], string> = { left: "to right", right: "to left", top: "to bottom", bottom: "to top" };

/** The incoming shot's mask at `progress`: opaque behind the edge (the side the occluder has passed). */
export function wipeMask(wipe: Wipe, progress: number): string {
  const edge = wipeEdgeAt(wipe, progress), soft = wipe.soft ?? 0.06;
  const a = ((edge - soft) * 100).toFixed(2), b = ((edge + soft) * 100).toFixed(2);
  return `linear-gradient(${GRADIENT_TO[wipe.from]}, black ${a}%, transparent ${b}%)`;
}

const OcclusionWipe: React.FC<Props<{ wipe: Wipe }>> = ({ presentationDirection, presentationProgress, passedProps, children }) => {
  if (presentationDirection === "exiting") return <AbsoluteFill>{children}</AbsoluteFill>;
  const mask = wipeMask(passedProps.wipe, presentationProgress);
  return <AbsoluteFill style={{ maskImage: mask, WebkitMaskImage: mask }}>{children}</AbsoluteFill>;
};

export function occlusionWipe(wipe: Wipe): TransitionPresentation<Record<string, unknown>> {
  return { component: OcclusionWipe as React.FC<TransitionPresentationComponentProps<Record<string, unknown>>>, props: { wipe } };
}

// ── Zoom through ────────────────────────────────────────────────

/** The incoming shot's starting scale, settling to 1 out of its matching region. */
export const ZOOM_IN_FROM = 1.8;
export const ZOOM_BLUR = 8;

export function zoomThroughStyle(zoom: Zoom, direction: "entering" | "exiting", progress: number): { scale: number; opacity: number; blur: number; origin: string } {
  const p = Math.min(1, Math.max(0, progress));
  if (direction === "exiting") {
    return {
      scale: interpolate(p, [0, 0.62], [1, zoom.scale ?? 2.4], { ...clamp, easing: Easing.in(Easing.cubic) }),
      opacity: interpolate(p, [0.48, 0.66], [1, 0], clamp),
      blur: interpolate(p, [0.3, 0.62], [0, ZOOM_BLUR], clamp),
      origin: `${(zoom.ax * 100).toFixed(1)}% ${(zoom.ay * 100).toFixed(1)}%`,
    };
  }
  return {
    scale: interpolate(p, [0.45, 1], [ZOOM_IN_FROM, 1], { ...clamp, easing: Easing.out(Easing.cubic) }),
    opacity: interpolate(p, [0.45, 0.62], [0, 1], clamp),
    blur: interpolate(p, [0.45, 0.85], [ZOOM_BLUR, 0], clamp),
    origin: `${(zoom.bx * 100).toFixed(1)}% ${(zoom.by * 100).toFixed(1)}%`,
  };
}

const ZoomThrough: React.FC<Props<{ zoom: Zoom }>> = ({ presentationDirection, presentationProgress, passedProps, children }) => {
  const s = zoomThroughStyle(passedProps.zoom, presentationDirection, presentationProgress);
  return (
    <AbsoluteFill style={{ opacity: s.opacity, transform: s.scale === 1 ? undefined : `scale(${s.scale.toFixed(4)})`, transformOrigin: s.origin, filter: s.blur > 0.2 ? `blur(${s.blur.toFixed(2)}px)` : undefined }}>
      {children}
    </AbsoluteFill>
  );
};

export function zoomThrough(zoom: Zoom): TransitionPresentation<Record<string, unknown>> {
  return { component: ZoomThrough as React.FC<TransitionPresentationComponentProps<Record<string, unknown>>>, props: { zoom } };
}

// ── Focus pull through depth ────────────────────────────────────

/** The grid's bytes, 0 far to 255 near; null when it does not decode to cols × rows. */
export function depthBytes(grid: DepthGrid): Uint8Array | null {
  try {
    const raw = atob(grid.grid);
    if (raw.length !== grid.cols * grid.rows) return null;
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const maskCache = new Map<string, string | null>();

/**
 * The depth map as a CSS luminance mask: white where it is far (`far`) or near, a soft blur between cells so the grid
 * never shows. Cached by grid, since a transition draws it every frame.
 */
export function depthMask(grid: DepthGrid, keep: "far" | "near"): string | null {
  const key = `${keep}:${grid.cols}x${grid.rows}:${grid.grid}`;
  if (maskCache.has(key)) return maskCache.get(key)!;
  const bytes = depthBytes(grid);
  let url: string | null = null;
  if (bytes) {
    const cells: string[] = [];
    for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.cols; x++) {
      const v = bytes[y * grid.cols + x], level = keep === "far" ? 255 - v : v;
      cells.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="rgb(${level},${level},${level})"/>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid.cols} ${grid.rows}" preserveAspectRatio="none"><filter id="s" x="0" y="0" width="100%" height="100%"><feGaussianBlur stdDeviation="0.7"/></filter><g filter="url(#s)">${cells.join("")}</g></svg>`;
    url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  }
  if (maskCache.size > 64) maskCache.clear();
  maskCache.set(key, url);
  return url;
}

/** The extra depth blur (px) of the masked region: the far side goes first on the way out; on the way in the near side settles first and the far one last. */
export function depthBlurAt(direction: "entering" | "exiting", progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return direction === "exiting"
    ? interpolate(p, [0, 0.4], [0, 14], { ...clamp, easing: Easing.out(Easing.quad) })
    : interpolate(p, [0.55, 1], [14, 0], { ...clamp, easing: Easing.inOut(Easing.quad) });
}

const DepthFocus: React.FC<Props<{ depth?: CutIn["depth"] }>> = ({ presentationDirection, presentationProgress, passedProps, children }) => {
  const s = focusPullStyle(presentationDirection, presentationProgress);
  const filter = s.blur > 0.2 || s.brightness !== 1 ? `blur(${s.blur.toFixed(2)}px) brightness(${s.brightness.toFixed(3)})` : undefined;
  const grid = presentationDirection === "exiting" ? passedProps.depth?.a : passedProps.depth?.b;
  const mask = grid ? depthMask(grid, "far") : null;
  const extra = depthBlurAt(presentationDirection, presentationProgress);
  return (
    <AbsoluteFill style={{ opacity: s.opacity, transform: s.scale === 1 ? undefined : `scale(${s.scale})`, filter }}>
      {children}
      {mask && extra > 0.2 ? <AbsoluteFill style={{ backdropFilter: `blur(${extra.toFixed(2)}px)`, WebkitBackdropFilter: `blur(${extra.toFixed(2)}px)`, maskImage: mask, WebkitMaskImage: mask, maskMode: "luminance", maskSize: "100% 100%", WebkitMaskSize: "100% 100%", pointerEvents: "none" }} /> : null}
    </AbsoluteFill>
  );
};

/** The focus pull with depth maps for one or both sides; without a usable map it draws exactly the plain focus pull. */
export function depthFocusPull(depth: CutIn["depth"]): TransitionPresentation<Record<string, unknown>> {
  return { component: DepthFocus as React.FC<TransitionPresentationComponentProps<Record<string, unknown>>>, props: { depth } };
}
