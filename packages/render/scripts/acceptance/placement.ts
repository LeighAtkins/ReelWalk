/**
 * Where a planar title's plane is on a given frame, computed from the
 * timeline the way `TextView` in ReelComposition.tsx does (ADR 0039/0043/0044):
 * the pinned progress on its clip's source time, the keyframe corners at that
 * progress, re-ordered upright with the pin's own order; a surface with no pin
 * sits where it was placed.
 *
 * This is a second reading of the placement data, kept behind one function
 * (`PlaneEvaluator`) so it can be swapped for the shared scene evaluator
 * (packages/core/src/scene.ts) once that lands: the harness then measures the
 * composition against the one contract instead of against this copy.
 */
import { framePlan, orientOrder, orientQuad, pinnedProgress, PINNED_ELSEWHERE, textPositionAt, textQuadAt, type TextOverlay, type Timeline } from "@reelwalk/core";

export type PlaneAt = {
  /** The plane's corners now (top left, top right, bottom right, bottom left), in frame fractions. */
  quad: number[];
  /** The plane the title was laid out in (the pinned corners, or the surface): its size sets the title's box. */
  base: number[];
  /** The path's own opacity at this frame (a tracked title fades where the tracker lost the surface). */
  opacity: number;
  /** True when the title is clipped to its plane (a chosen surface): no glyph may fall outside it. */
  clipped: boolean;
};

export type PlaneEvaluator = (timeline: Timeline, text: TextOverlay, frame: number, fps: number) => PlaneAt | null;

/** The composition's own placement, read the same way it reads it. Null when the title has no plane on this frame. */
export const planeFromPath: PlaneEvaluator = (timeline, text, frame, fps) => {
  const entry = framePlan(timeline, fps).texts.find((item) => item.text.id === text.id);
  if (!entry || frame < entry.from || frame >= entry.from + entry.durationInFrames) return null;
  const local = frame - entry.from;
  const progress = text.pin ? pinnedProgress(timeline, text, (frame * 1000) / fps, fps) : entry.durationInFrames > 1 ? local / (entry.durationInFrames - 1) : 0;
  if (text.pin && progress === PINNED_ELSEWHERE) return null;
  const bare = text.surface && !text.pin ? orientQuad(text.surface) : null;
  const order = text.pin?.quad ? orientOrder(text.pin.quad) : null;
  const reorder = (q: number[] | null): number[] | null => (q && order ? order.flatMap((i) => [q[i * 2], q[i * 2 + 1]]) : q);
  const quad = reorder(textQuadAt(text, progress)) ?? bare;
  const base = (text.pin?.quad ? reorder(text.pin.quad) : bare) ?? null;
  if (!quad || !base) return null;
  return { quad, base, opacity: textPositionAt(text, progress).opacity, clipped: Boolean(text.surface) };
};

/** Five moments of a title's life on its plane: first, quarter, half, three quarters, last. */
export function fiveFrames(timeline: Timeline, text: TextOverlay, fps: number, evaluate: PlaneEvaluator = planeFromPath): number[] {
  const entry = framePlan(timeline, fps).texts.find((item) => item.text.id === text.id);
  if (!entry) return [];
  const on: number[] = [];
  for (let f = entry.from; f < entry.from + entry.durationInFrames; f++) if (evaluate(timeline, text, f, fps)) on.push(f);
  if (!on.length) return [];
  return [...new Set([0, 0.25, 0.5, 0.75, 1].map((p) => on[Math.round(p * (on.length - 1))]))];
}
