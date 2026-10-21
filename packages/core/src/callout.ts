/**
 * Pinned callouts (ADR 0061): a small label with a leader line to a feature
 * of the room ("Heated floors"), the point followed with the surface tracker.
 *
 * Saved data: `text.callout = { x, y }` is the feature, frame fractions on the
 * title's first frame; `text.x/y` is the label's centre on that frame. Pinning
 * tracks a small square around the point (`calloutQuad`) with the ordinary
 * pin path (ADR 0039/0052), so `pin.quad` is that square and every keyframe's
 * `q` is where it went. Nothing else is stored.
 *
 * API
 *
 *   calloutQuad(point): number[]          the square tracked around the point (tl tr br bl, fractions).
 *   calloutTrackTarget(text): text-like   what Pin hands the tracker: the point as x/y, the square as the surface.
 *   calloutAnchorAt(text, progress): {x,y} the point on this frame (fractions): the pinned square's homography
 *                                         applied to it; the saved point when unpinned or untracked.
 *   calloutGeometry(input): CalloutGeometry
 *     the dot, the leader line and the label's reveal on one frame, composition
 *     px, as a pure function of the title's time: the dot pops, the line draws
 *     out from it, the label follows; all of it fades over the last 250 ms and
 *     wherever the track was lost (the placement's opacity, applied by the renderer).
 *
 * Invariants:
 *   - The label keeps its size and angle (it is read, not painted on the wall);
 *     it travels with the point, so the line's length and angle hold.
 *   - The line never runs into the label: it ends `gap` px outside the label's box.
 */
import { applyHomography, homography, type Quad } from "./motion";
import { PINNED_ELSEWHERE, textQuadAt } from "./cinematic";
import type { TextOverlay } from "./timeline";

/** Half the tracked square around the point: 8% of the width by 4.5% of the height, about 170 px square at 1080 × 1920. */
export const CALLOUT_TRACK_HALF = { x: 0.08, y: 0.045 } as const;

/** The square around a point the tracker follows, tl tr br bl in frame fractions (4 decimals, as the timeline keeps them). */
export function calloutQuad(point: { x: number; y: number }): number[] {
  const { x: hx, y: hy } = CALLOUT_TRACK_HALF;
  const x0 = point.x - hx, x1 = point.x + hx, y0 = point.y - hy, y1 = point.y + hy;
  return [x0, y0, x1, y0, x1, y1, x0, y1].map((v) => Number(Math.min(1.5, Math.max(-0.5, v)).toFixed(4)));
}

/** What Pin tracks for a callout: the point's square, with the point as the target's centre so the path's x/y are its travel. */
export function calloutTrackTarget<T extends Pick<TextOverlay, "x" | "y" | "startMs" | "endMs" | "callout">>(text: T): T & { surface?: number[] } {
  if (!text.callout) return text;
  return { ...text, x: text.callout.x, y: text.callout.y, surface: calloutQuad(text.callout) };
}

/** The callout's point on this frame, frame fractions. */
export function calloutAnchorAt(text: TextOverlay, progress: number): { x: number; y: number } {
  const point = text.callout ?? { x: text.x, y: text.y };
  if (!text.pin?.quad || progress === PINNED_ELSEWHERE) return point;
  const quad = textQuadAt(text, progress);
  if (!quad) return point;
  const H = homography(text.pin.quad as Quad, quad as Quad);
  if (!H) return point;
  const [x, y] = applyHomography(H, point.x, point.y);
  return { x, y };
}

export type CalloutGeometry = {
  dot: { x: number; y: number; r: number; opacity: number };
  /** The leader line from the dot towards the label, `drawn` of the way (0..1); null when the dot is under the label. */
  line: { x1: number; y1: number; x2: number; y2: number; drawn: number } | null;
  /** The label's own reveal (0..1) and how far it still has to settle, px towards the dot. */
  label: { opacity: number; shift: { x: number; y: number } };
  /** The whole callout's exit fade (multiplies everything). */
  opacity: number;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutCubic = (p: number) => 1 - Math.pow(1 - clamp01(p), 3);
const easeOutBack = (p: number) => { const t = clamp01(p) - 1; return 1 + 2.2 * t * t * t + 1.2 * t * t; };

/** Timing of the reveal, ms after the title appears. */
export const CALLOUT_TIMING = { dot: [0, 220], line: [140, 520], label: [380, 680], exit: 250 } as const;
/** The dot's radius and the gap between the line's end and the label, px at 1080 wide. */
export const CALLOUT_DOT_PX = 12;
export const CALLOUT_GAP_PX = 12;

/** Where a ray from the box's centre towards `to` leaves the box grown by `gap`. */
function boxExit(center: { x: number; y: number }, half: { x: number; y: number }, to: { x: number; y: number }, gap: number): { x: number; y: number } | null {
  const dx = to.x - center.x, dy = to.y - center.y;
  const hx = half.x + gap, hy = half.y + gap;
  if (Math.abs(dx) <= hx && Math.abs(dy) <= hy) return null;
  const k = Math.min(dx === 0 ? Infinity : hx / Math.abs(dx), dy === 0 ? Infinity : hy / Math.abs(dy));
  return { x: center.x + dx * k, y: center.y + dy * k };
}

/** One frame of a callout. Everything in composition px. See the module comment. */
export function calloutGeometry(input: {
  anchor: { x: number; y: number };
  /** The label's centre and half its box (the words plus the style's padding), composition px. */
  label: { x: number; y: number; halfWidth: number; halfHeight: number };
  titleMs: number;
  lifeMs: number;
  /** Composition width, for the px sizes (given at 1080). */
  width?: number;
}): CalloutGeometry {
  const { anchor, label, titleMs, lifeMs } = input;
  const k = (input.width ?? 1080) / 1080;
  const t = CALLOUT_TIMING;
  const at = (span: readonly [number, number]) => clamp01((titleMs - span[0]) / (span[1] - span[0]));
  const opacity = clamp01((lifeMs - titleMs) / t.exit);
  const pop = at(t.dot);
  const dot = { x: anchor.x, y: anchor.y, r: CALLOUT_DOT_PX * k * Math.max(0, easeOutBack(pop)), opacity: clamp01(pop * 3) };
  const end = boxExit({ x: label.x, y: label.y }, { x: label.halfWidth, y: label.halfHeight }, anchor, CALLOUT_GAP_PX * k);
  // The line leaves the dot at its rim.
  const length = end ? Math.hypot(end.x - anchor.x, end.y - anchor.y) : 0;
  const rim = Math.min(length, CALLOUT_DOT_PX * k * 1.4);
  const line = end && length > rim + 1
    ? { x1: anchor.x + ((end.x - anchor.x) * rim) / length, y1: anchor.y + ((end.y - anchor.y) * rim) / length, x2: end.x, y2: end.y, drawn: easeOutCubic(at(t.line)) }
    : null;
  const shown = easeOutCubic(at(t.label));
  const away = end ? { x: (end.x - anchor.x) / (length || 1), y: (end.y - anchor.y) / (length || 1) } : { x: 0, y: 0 };
  // The label settles outwards along the line: it starts 14 px nearer the dot.
  const shift = { x: -away.x * 14 * k * (1 - shown), y: -away.y * 14 * k * (1 - shown) };
  return { dot, line, label: { opacity: shown, shift }, opacity };
}

/** The callout's dot and line as an SVG string over the whole composition (width × height), for one frame. */
export function calloutSvg(g: CalloutGeometry, size: { width: number; height: number }, colour: string): string {
  const f = (v: number) => v.toFixed(1);
  const shadow = "rgba(0,0,0,0.45)";
  const lw = (4 * size.width) / 1080;
  const parts: string[] = [];
  if (g.line && g.line.drawn > 0) {
    const x2 = g.line.x1 + (g.line.x2 - g.line.x1) * g.line.drawn, y2 = g.line.y1 + (g.line.y2 - g.line.y1) * g.line.drawn;
    parts.push(`<line x1="${f(g.line.x1)}" y1="${f(g.line.y1 + lw * 0.6)}" x2="${f(x2)}" y2="${f(y2 + lw * 0.6)}" stroke="${shadow}" stroke-width="${f(lw * 1.8)}" stroke-linecap="round"/>`);
    parts.push(`<line x1="${f(g.line.x1)}" y1="${f(g.line.y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${colour}" stroke-width="${f(lw)}" stroke-linecap="round"/>`);
  }
  if (g.dot.r > 0.1) {
    parts.push(`<circle cx="${f(g.dot.x)}" cy="${f(g.dot.y)}" r="${f(g.dot.r * 1.9)}" fill="${colour}" fill-opacity="${(0.22 * g.dot.opacity).toFixed(3)}"/>`);
    parts.push(`<circle cx="${f(g.dot.x)}" cy="${f(g.dot.y + lw * 0.5)}" r="${f(g.dot.r)}" fill="${shadow}" fill-opacity="${g.dot.opacity.toFixed(3)}"/>`);
    parts.push(`<circle cx="${f(g.dot.x)}" cy="${f(g.dot.y)}" r="${f(g.dot.r)}" fill="${colour}" fill-opacity="${g.dot.opacity.toFixed(3)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${parts.join("")}</svg>`;
}
