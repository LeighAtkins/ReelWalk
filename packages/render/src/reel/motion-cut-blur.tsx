import React, { useId } from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import type { CutBlur } from "@reelwalk/core";
import { zoomBlurStageCount, zoomFilterSpec, zoomStageId } from "./zoom-blur";

/**
 * The blur of a motion-hidden cut (ADR 0090) on one frame of one clip: core's `cutBlurAt` says how much and which way;
 * this draws it with SVG filters through CSS `filter: url(#…)`, which the phone Player and the worker's Chrome both
 * draw the same (no WebGL, no HTML-in-canvas). The layers are always mounted the same way and only their styles change,
 * so the footage under them is never remounted as the blur starts or stops.
 *
 * - A pan or tilt within 12° of an axis: one anisotropic Gaussian along that axis, the frame's edges duplicated.
 * - A diagonal: the layer is turned onto the motion's angle, blurred along its x and turned back, and the picture inside
 *   is scaled up by three sigmas so the blur never reads the clear corners (scaled only while the blur is on, and the
 *   blur hides the step).
 * - A push or pull: the zoom blur of ADR 0074 (zoom-blur.ts), copies scaled about the frame's centre, chained per stage.
 */

/** How close to horizontal or vertical a direction must be for the plain axis blur, degrees. */
const AXIS_SNAP_DEG = 12;

export type CutBlurPlan =
  | { kind: "none" }
  | { kind: "axis"; sx: number; sy: number }
  | { kind: "turned"; angleDeg: number; sigma: number; scale: number }
  | { kind: "zoom"; spread: number };

/** What to draw for a blur on a frame `width` × `height`. Pure, for tests. */
export function cutBlurPlan(blur: CutBlur | null, width: number, height: number): CutBlurPlan {
  if (!blur) return { kind: "none" };
  if (blur.kind === "zoom") return { kind: "zoom", spread: blur.spread };
  const angle = ((blur.angleDeg % 180) + 180) % 180;
  if (angle <= AXIS_SNAP_DEG || angle >= 180 - AXIS_SNAP_DEG) return { kind: "axis", sx: blur.sigmaPx, sy: 0 };
  if (Math.abs(angle - 90) <= AXIS_SNAP_DEG) return { kind: "axis", sx: 0, sy: blur.sigmaPx };
  return { kind: "turned", angleDeg: angle, sigma: blur.sigmaPx, scale: Math.round((1 + (6 * blur.sigmaPx) / Math.min(width, height)) * 1000) / 1000 };
}

/** The CSS filter value for a plan, pointing at the filters `<CutBlurFilters id>` mounts. */
export function cutBlurFilter(plan: CutBlurPlan, id: string): string | undefined {
  if (plan.kind === "axis" || plan.kind === "turned") return `url(#${id})`;
  if (plan.kind === "zoom") return Array.from({ length: zoomBlurStageCount(plan.spread) }, (_, s) => `url(#${zoomStageId(id, s)})`).join(" ");
  return undefined;
}

const CutBlurFilters: React.FC<{ id: string; plan: CutBlurPlan; width: number; height: number }> = ({ id, plan, width, height }) => {
  if (plan.kind === "zoom") {
    const spec = zoomFilterSpec(plan.spread, 0.5, 0.5, width, height);
    return (
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        {spec.stages.map((stage, s) => (
          <filter key={s} id={zoomStageId(id, s)} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feImage href={spec.map} x="0" y="0" width={spec.width} height={spec.height} preserveAspectRatio="none" result="zmap" />
            <feDisplacementMap in="SourceGraphic" in2="zmap" scale={stage.scale.toFixed(2)} xChannelSelector="R" yChannelSelector="G" result="zc" />
            <feComposite in="SourceGraphic" in2="zc" operator="arithmetic" k1="0" k2={stage.keep.toFixed(4)} k3={stage.add.toFixed(4)} k4="0" />
          </filter>
        ))}
      </svg>
    );
  }
  const std = plan.kind === "axis" ? `${plan.sx.toFixed(2)} ${plan.sy.toFixed(2)}` : plan.kind === "turned" ? `${plan.sigma.toFixed(2)} 0` : "0 0";
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation={std} edgeMode="duplicate" />
      </filter>
    </svg>
  );
};

/** The clip's picture under the blur of its motion cuts, in or out; `blur` null leaves it untouched (but mounted the same). */
export const MotionCutBlur: React.FC<{ blur: CutBlur | null; children: React.ReactNode }> = ({ blur, children }) => {
  const { width, height } = useVideoConfig();
  const id = `mcut-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const plan = cutBlurPlan(blur, width, height);
  const filter = cutBlurFilter(plan, id);
  const turned = plan.kind === "turned" ? plan : null;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <CutBlurFilters id={id} plan={plan} width={width} height={height} />
      <AbsoluteFill style={{ filter, transform: turned ? `rotate(${turned.angleDeg}deg)` : undefined }}>
        <AbsoluteFill style={{ transform: turned ? `rotate(${-turned.angleDeg}deg) scale(${turned.scale})` : undefined }}>{children}</AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
