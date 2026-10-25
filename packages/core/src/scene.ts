/**
 * Scene evaluation for titles (ADR 0046): where a text overlay is on one
 * frame, and what draws above it. The renderer (ReelComposition's TextView)
 * and the editor's handles consume this and nothing else; neither does its
 * own placement geometry.
 *
 * API
 *
 *   evaluateTitle(input: TitleInput): TitlePlacement
 *     input.text      the saved overlay (v1 schema, unchanged)
 *     input.timeline  the reel (a pinned title reads the clip on screen from it)
 *     input.frame     frames since the title's own first frame (its Sequence frame)
 *     input.from      the title's first frame in the reel
 *     input.durationInFrames, input.fps, input.width, input.height  the composition
 *     input.font      the title's resolved font (family, weight, px size, tracking, stretch)
 *     input.measure   (line, font) => { width, height } in composition px; injected,
 *                     so this module never touches a DOM (the renderer passes a span
 *                     measurer, tests pass a fixed-advance one)
 *
 *   returns one of
 *     { kind: "hidden" }   a pinned title while a different shot is on screen
 *     { kind: "screen", center, wrap, scale, rotation, opacity, occluderTaps }
 *     { kind: "surface", plane, restPlane, rect, homography, placed, fitScale,
 *       lineBox, lines, clipToPlane, maskShapes, occluderTaps, opacity }
 *
 *   sceneLayers(timeline, fps, hasVideo?): SceneLayer[]
 *     the bottom-to-top order of titles and the mattes that occlude them.
 *
 * Coordinate spaces, always named:
 *   fraction     0..1 of the composition; what the v1 schema saves (x, y, surface,
 *                pin.quad, path q, bars, cutouts, occluders).
 *   composition  pixels of the output frame (1080 × 1920). Everything this module
 *                returns is in composition px unless it says otherwise.
 *   viewport     the editor's CSS px; composition × (viewport width / composition width).
 *                Not used here; a consumer scales uniformly.
 *   plane        pixels of a surface title's own rectangle (rect.width × rect.height),
 *                origin at its top-left corner; the text is laid out here and warped
 *                to the frame by `homography`.
 *   source       the footage's own pixels; not used here (mattes map it through fitRects).
 *
 * Invariants:
 *   - One authority per title. The kind is derived once, here, from the saved
 *     fields (the v1 adapter below); nothing else decides whether a title is on
 *     the screen or on a surface.
 *   - Saved data is never reinterpreted: corner order is resolved with
 *     orientQuad/orientOrder exactly as before and nothing is written back.
 *   - The fill rules are the ones existing reels were rendered with: a chosen
 *     surface is filled to 94% of its width or 92% of its height (the average
 *     opposite-edge rectangle); a tracked plane without a chosen surface is fitted
 *     to the frame (`planarFitAndShift`, 92% of the frame).
 *   - `opacity` here is placement opacity only (tracked `o`, the early-end tail);
 *     the entrance animation multiplies it in the renderer.
 *   - A title's occluders (presenter matte for `behind`, tapped objects) draw
 *     above that title, never above a title that did not ask for them.
 */
import { applyHomography, homography, invertHomography, orientOrder, orientQuad, type Quad } from "./motion";
import { endsBeforeShot, locateFrame, PINNED_ELSEWHERE, pinnedProgress, textPositionAt, textQuadAt } from "./cinematic";
import { INSTAGRAM } from "./instagram";
import { framePlan, REEL_FORMAT, type Clip, type TextOverlay, type Timeline } from "./timeline";
import { calloutAnchorAt } from "./callout";

/** A title's resolved font, as the renderer styles it. `fontSize` in composition px. */
/** `fontVariantNumeric` is set when the figures are drawn tabular (a count-up, ADR 0061), so the measure matches what is drawn. */
export type TitleFont = { fontFamily?: string; fontWeight?: string | number; fontSize: number; letterSpacing?: number; fontStretch?: string; fontVariantNumeric?: string; /** "uppercase" when the style sets the words in capitals (ADR 0078), so the measure sees the width that is drawn. */ textTransform?: string };

/** Measures one line of text, unwrapped, in composition px. */
export type Measure = (line: string, font: TitleFont) => { width: number; height: number };

/**
 * A style's letter spacing as the em number a TitleFont carries ("0.06em" → 0.06), or undefined for
 * none or a unit the measure cannot apply: a title's own `tracking` wins when it has one, but a style's
 * spacing (the elegant face's 0.06 em) is drawn too, so the measure must see it.
 */
export function letterSpacingEm(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim().endsWith("em")) return undefined;
  const em = parseFloat(value);
  return Number.isFinite(em) ? em : undefined;
}

export type TitleInput = {
  text: TextOverlay;
  timeline: Timeline;
  /** Frames since the title's first frame. */
  frame: number;
  /** The title's first frame in the reel. */
  from: number;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  font: TitleFont;
  measure: Measure;
};

/** A point as x, y (fractions or composition px, as the field says). Named apart from track.ts's [x, y] Point. */
export type ScenePoint = { x: number; y: number };

export type ScreenPlacement = {
  kind: "screen";
  /** Path progress the placement was read at (0..1 for a drift; a pin's source-time progress). */
  progress: number;
  /** Centre of the text box, composition px. */
  center: ScenePoint;
  /** A sentence wraps inside `width`; a single word stays on one line, up to `maxWidth`. */
  wrap: { mode: "wrap"; width: number } | { mode: "line"; maxWidth: number };
  /** Path scale and rotation (degrees). */
  scale: number;
  rotation: number;
  opacity: number;
  /** Tapped occluders on this frame, fractions. */
  occluderTaps: ScenePoint[];
  /** A callout (ADR 0061): the point its leader line runs to on this frame, composition px. `center` is its label's. */
  callout?: { anchor: ScenePoint };
};

export type SurfacePlacement = {
  kind: "surface";
  progress: number;
  /** The plane's corners on this frame (tl, tr, br, bl), composition px. */
  plane: Quad;
  /** The plane's corners where it was placed (pin time, or the bare surface), composition px. */
  restPlane: Quad;
  /** The plane rectangle: its size (plane px) and where its origin sits before warping (restPlane's tl, composition px). */
  rect: { left: number; top: number; width: number; height: number };
  /** Plane px → composition px on this frame (row-major 3×3), or null when the corners are degenerate. */
  homography: number[] | null;
  /** The same map relative to rect.left/top: what a CSS matrix3d on a box placed at left/top uses. */
  placed: number[] | null;
  /** Scale applied to the text's natural size so it fills the surface or fits the frame. */
  fitScale: number;
  /** The text block's natural size, composition px: the widest typed line by the house leading (1.12 × size per line). */
  lineBox: { width: number; height: number };
  lines: number;
  /** A chosen surface clips the words to its rectangle; a tracked plane without one lets them overflow. */
  clipToPlane: boolean;
  /** Posts and cut-outs as polygons in plane px ([x0, y0, x1, y1, …]), or null when none apply. */
  maskShapes: number[][] | null;
  occluderTaps: ScenePoint[];
  opacity: number;
};

export type TitlePlacement = { kind: "hidden"; progress: number; opacity: 0 } | ScreenPlacement | SurfacePlacement;

/** The largest fraction of the frame a planar title may span. */
export const PLANAR_MAX_WIDTH = 0.92;
/** A chosen surface is filled to this share of its rectangle's width… */
export const SURFACE_FILL_WIDTH = 0.94;
/** …or of its height, whichever binds first. */
export const SURFACE_FILL_HEIGHT = 0.92;
/** The house line height, as a multiple of the font size. */
export const TITLE_LEADING = 1.12;
/** Seconds over which a pinned title shortened before its shot ends fades out (ADR 0044). */
export const EARLY_END_FADE_S = 0.4;

/**
 * How much to shrink a planar title, and how far to move it, so its line fits
 * the frame once it is warped onto the pinned plane: the text is centred in the
 * plane's rectangle and projected through the homography to the (leaned)
 * corners, so a near edge magnified by perspective counts. `fit` ≤ 1 scales the
 * text; `shift` is the change to the title's centre x (frame fraction) that
 * keeps the projected line 3% inside both edges. Fractions in, fractions out.
 * This is the fit for a tracked plane without a chosen surface; a chosen
 * surface is filled instead (see evaluateTitle).
 */
export function planarFitAndShift(quad0: readonly number[], widthFraction: number, maxWidth = PLANAR_MAX_WIDTH): { fit: number; shift: number; left: number; right: number } {
  const left = quad0[0], top = quad0[1], w = Math.max(1e-6, quad0[2] - quad0[0]), h = Math.max(1e-6, quad0[7] - quad0[1]);
  const now = quad0.map((v, i) => (i % 2 === 0 ? v - left : v - top)) as Quad;
  const H = homography([0, 0, w, 0, w, h, 0, h], now);
  const extents = (fit: number): [number, number] => {
    const half = (widthFraction * fit) / 2, y = h / 2;
    if (!H) return [left + w / 2 - half, left + w / 2 + half];
    const a = applyHomography(H, w / 2 - half, y)[0] + left, b = applyHomography(H, w / 2 + half, y)[0] + left;
    return [Math.min(a, b), Math.max(a, b)];
  };
  let fit = 1;
  for (let i = 0; i < 4; i++) {
    const [l, r] = extents(fit);
    const span = r - l;
    if (span <= maxWidth) break;
    fit *= maxWidth / span;
  }
  const [l, r] = extents(fit);
  const shift = l < 0.03 ? 0.03 - l : r > 0.97 ? 0.97 - r : 0;
  return { fit, shift, left: l + shift, right: r + shift };
}

/**
 * The v1 adapter: which corners, if any, the title is drawn on this frame.
 * `plane` is the rest plane (pin quad, or the bare surface); `quad` where it is now.
 * Both null → a screen title. Rules, unchanged from the pre-0046 renderer:
 *   - a surface with no pin yet is drawn inside that surface as it stands, upright (orientQuad);
 *   - a pin with a quad keeps its corners' placement order, and every keyframe is
 *     re-ordered by the same permutation (orientOrder) so a mirrored placement reads upright;
 *   - a pin whose keyframes carry no corners, or a pin without a quad, is a screen title.
 */
export function titleCorners(text: TextOverlay, progress: number): { plane: number[]; quad: number[] } | null {
  // A callout's pin follows its point, not a plane to paint on (ADR 0061): its label is a screen title.
  if (text.callout) return null;
  const bare = text.surface && !text.pin ? orientQuad(text.surface) : null;
  const order = text.pin?.quad ? orientOrder(text.pin.quad) : null;
  const reorder = (q: number[] | null): number[] | null => (q && order ? order.flatMap((i) => [q[i * 2], q[i * 2 + 1]]) : q);
  const quad = reorder(textQuadAt(text, progress)) ?? bare;
  const plane = (text.pin?.quad ? reorder(text.pin.quad) : bare) ?? null;
  return quad && plane ? { plane, quad } : null;
}

/** Where a title's tapped occluders (first-frame fractions) are at `progress`: carried by its tracked plane when it has one. */
export function carryTaps(text: TextOverlay, progress: number): ScenePoint[] {
  const taps = (text.occluders ?? []).map((tap) => ({ x: tap.x, y: tap.y }));
  if (!text.pin?.quad) return taps;
  const quad = textQuadAt(text, progress);
  if (!quad) return taps;
  const H = homography(text.pin.quad as Quad, quad as Quad);
  if (!H) return taps;
  return taps.map((tap) => { const [x, y] = applyHomography(H, tap.x, tap.y); return { x, y }; });
}

/** Path progress for a title on its `frame`: a pin runs on its clip's source time (ADR 0039), a drift over the title's own life. */
export function titleProgress(input: Pick<TitleInput, "text" | "timeline" | "frame" | "from" | "durationInFrames" | "fps">): number {
  const { text, timeline, frame, from, durationInFrames, fps } = input;
  if (text.pin) return pinnedProgress(timeline, text, ((from + frame) * 1000) / fps, fps);
  return durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;
}

/** Linear 1 → 0 between frames a and b, clamped (Remotion's interpolate, without Remotion). */
function fadeOut(frame: number, a: number, b: number): number {
  if (frame <= a) return 1;
  if (frame >= b) return 0;
  return 1 - (frame - a) / (b - a);
}

function multiply3(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return out;
}

/** A callout's label is at most this share of the frame wide (ADR 0061). */
export const CALLOUT_MAX_WIDTH = 0.86;

/**
 * A callout label's centre (composition px), kept inside Instagram's safe area: its measured line (at most
 * CALLOUT_MAX_WIDTH of the frame) plus room for a label's padding (0.4 em a side, 0.2 em above and below) stays clear
 * of the caption and buttons whatever the tracked point does. The leader line follows the label.
 */
export function calloutLabelInSafeArea(text: TextOverlay, label: { x: number; y: number }, input: Pick<TitleInput, "width" | "height" | "font" | "measure">): ScenePoint {
  const { width, height, font, measure } = input;
  const lines = text.text.split(/\n/);
  const lineW = Math.min(width * CALLOUT_MAX_WIDTH, Math.max(...lines.map((line) => measure(line || " ", font).width)));
  const halfW = lineW / 2 + font.fontSize * 0.4, halfH = (font.fontSize * TITLE_LEADING * lines.length) / 2 + font.fontSize * 0.2;
  const safe = INSTAGRAM.safeZonePx, sx = width / REEL_FORMAT.width, sy = height / REEL_FORMAT.height;
  const fit = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return { x: fit(label.x * width, safe.left * sx + halfW, width - safe.right * sx - halfW), y: fit(label.y * height, safe.top * sy + halfH, height - safe.bottom * sy - halfH) };
}

/**
 * The padding a style draws around its words, in em (the renderer's `textCss`,
 * packages/render look.ts): a label's and a sticker's background box. Other
 * styles draw the words alone.
 */
export const TITLE_PADDING_EM: Partial<Record<TextOverlay["style"], { x: number; y: number }>> = {
  box: { x: 0.36, y: 0.18 },
  tag: { x: 0.34, y: 0.2 },
};

/** The padding a title's style draws around its words, in composition px. */
export function titlePaddingPx(text: Pick<TextOverlay, "style">, font: TitleFont): { x: number; y: number } {
  const em = TITLE_PADDING_EM[text.style];
  return em ? { x: em.x * font.fontSize, y: em.y * font.fontSize } : { x: 0, y: 0 };
}

/**
 * The lines a title breaks into inside `width`, as the renderer's wrapping
 * does: a typed line break always breaks; words fill each line greedily and go
 * to the next when the measured line would overrun; one word wider than the
 * line stands alone (the renderer breaks it mid-word, so it never overruns).
 */
export function wrapTitleLines(text: string, font: TitleFont, measure: Measure, width: number): string[] {
  const lines: string[] = [];
  for (const part of text.split("\n")) {
    const words = part.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) { lines.push(""); continue; }
    let line = words[0];
    for (const word of words.slice(1)) {
      const joined = `${line} ${word}`;
      if (measure(joined, font).width <= width) line = joined;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * The box a screen title draws, in composition px before its scale. The
 * renderer lays the words out in a column of `wrap.width` as a flex item:
 * as wide as its words (plus the style's padding) until they wrap, then the
 * column. So the drawn box is the longest wrapped line plus the padding,
 * never the column, for a style that draws the words alone; a label or a
 * sticker paints its background on that item, so once its words wrap its
 * box is the whole column however short the lines. Lines times the leading
 * plus the padding for the height.
 */
export function screenTitleExtent(text: Pick<TextOverlay, "text" | "style">, font: TitleFont, measure: Measure, wrap: ScreenPlacement["wrap"]): { width: number; height: number; lines: string[]; column: boolean } {
  const pad = titlePaddingPx(text, font);
  const typed = text.text.split("\n");
  const widestTyped = Math.max(...typed.map((line) => measure(line || " ", font).width));
  const wraps = wrap.mode === "wrap" && widestTyped + 2 * pad.x > wrap.width;
  const lines = wraps ? wrapTitleLines(text.text, font, measure, Math.max(1, wrap.width - 2 * pad.x)) : typed;
  const column = wraps && TITLE_PADDING_EM[text.style] !== undefined;
  const widest = Math.max(...lines.map((line) => measure(line || " ", font).width));
  const width = column ? wrap.width : Math.min(wrap.mode === "wrap" ? wrap.width : wrap.maxWidth, widest + 2 * pad.x);
  return { width, height: font.fontSize * TITLE_LEADING * lines.length + 2 * pad.y, lines, column };
}

/** The single evaluated placement of one title on one frame. See the module comment. */
export function evaluateTitle(input: TitleInput): TitlePlacement {
  const { text, timeline, frame, durationInFrames, fps, width, height, font, measure } = input;
  const progress = titleProgress(input);
  // A pinned title belongs to its shot: while another clip is on screen it is not drawn at all.
  if (text.pin && progress === PINNED_ELSEWHERE) return { kind: "hidden", progress, opacity: 0 };
  const position = textPositionAt(text, progress);
  // A tracked title fades where the tracker lost the surface (keyframe `o`); one taken off before its
  // shot ends (ADR 0044) fades over its last 0.4 s rather than vanishing mid-shot.
  const tail = text.pin && endsBeforeShot(timeline, text) ? fadeOut(frame, Math.max(0, durationInFrames - Math.round(EARLY_END_FADE_S * fps)), durationInFrames) : 1;
  const opacity = position.opacity * tail;
  const occluderTaps = carryTaps(text, progress);
  const corners = titleCorners(text, progress);

  if (!corners && text.callout) {
    // A callout (ADR 0061): the label keeps its size and angle and travels with its tracked point; one line, never wrapped.
    // Unpinned, it points at something in the shot it starts on: once the cut lands it goes, rather than point at the next shot.
    if (!text.pin) {
      const first = locateFrame(timeline, (input.from * 1000) / fps, fps), now = locateFrame(timeline, ((input.from + frame) * 1000) / fps, fps);
      if (first && now && first.index !== now.index) return { kind: "hidden", progress, opacity: 0 };
    }
    const anchor = calloutAnchorAt(text, progress);
    const label = text.pin?.quad ? { x: text.x + anchor.x - text.callout.x, y: text.y + anchor.y - text.callout.y } : { x: position.x, y: position.y };
    return {
      kind: "screen", progress, center: calloutLabelInSafeArea(text, label, input), wrap: { mode: "line", maxWidth: width * CALLOUT_MAX_WIDTH }, scale: 1, rotation: 0, opacity, occluderTaps,
      callout: { anchor: { x: anchor.x * width, y: anchor.y * height } },
    };
  }
  if (!corners) {
    // A single word never breaks mid-word (a tracked title is usually one word); sentences wrap inside the safe width.
    const wrap: ScreenPlacement["wrap"] = /\s/.test(text.text) ? { mode: "wrap", width: width * 0.86 } : { mode: "line", maxWidth: width * 1.4 };
    return { kind: "screen", progress, center: { x: position.x * width, y: position.y * height }, wrap, scale: position.scale, rotation: position.rotation, opacity, occluderTaps };
  }

  const { plane, quad } = corners;
  // A planar title never wraps: the widest typed line sets the width (fraction of the frame).
  const parts = text.text.split("\n");
  const line = Math.max(...parts.map((part) => measure(part || " ", font).width / width));
  // The plane's own rectangle: as wide as the average of its top and bottom edges and as tall as the
  // average of its sides, in px. One edge alone (the top for width, the left for height) made a title
  // grow to fill a long top edge and then warp thin onto a short bottom one as a corner was dragged.
  const px = (i: number) => plane[i * 2] * width, py = (i: number) => plane[i * 2 + 1] * height;
  const edge = (a: number, b: number) => Math.hypot(px(b) - px(a), py(b) - py(a));
  const w = Math.max(1, (edge(0, 1) + edge(3, 2)) / 2), h = Math.max(1, (edge(0, 3) + edge(1, 2)) / 2);
  const rectWidth = Math.max(0.05, w / width);
  const rectHeight = Math.max(0.02, h / height);
  const lines = parts.length;
  const lineHeight = ((font.fontSize * TITLE_LEADING) / height) * lines;
  // A chosen surface is filled (94% of its width, as long as it fits 92% of its height); a tracked plane
  // without one is fitted to the frame.
  const fitScale = text.surface ? Math.min((rectWidth * SURFACE_FILL_WIDTH) / line, (rectHeight * SURFACE_FILL_HEIGHT) / lineHeight) : planarFitAndShift(plane, line).fit;
  const left = plane[0] * width, top = plane[1] * height;
  const local = (q: readonly number[]) => q.map((v, i) => (i % 2 === 0 ? v * width - left : v * height - top)) as Quad;
  const unit: Quad = [0, 0, w, 0, w, h, 0, h];
  const placed = homography(unit, local(quad));
  const absolute = placed ? multiply3([1, 0, left, 0, 1, top, 0, 0, 1], placed) : null;

  // Posts and cut-outs stand in front of the surface: drawn at the rest plane, mapped into plane px so they warp with it.
  let maskShapes: number[][] | null = null;
  if (text.surface && (text.bars?.length || text.cutouts?.length)) {
    const H0 = homography(unit, local(plane));
    const inv = H0 ? invertHomography(H0) : null;
    if (inv) {
      const toPlane = (x: number, y: number): [number, number] => {
        const sx = x * width - left, sy = y * height - top;
        const d = inv[6] * sx + inv[7] * sy + inv[8] || 1e-9;
        return [(inv[0] * sx + inv[1] * sy + inv[2]) / d, (inv[3] * sx + inv[4] * sy + inv[5]) / d];
      };
      maskShapes = [...(text.bars ?? []), ...(text.cutouts ?? [])].map((shape) => Array.from({ length: shape.length / 2 }, (_, i) => toPlane(shape[i * 2], shape[i * 2 + 1])).flat());
    }
  }

  const toPx = (q: readonly number[]) => q.map((v, i) => (i % 2 === 0 ? v * width : v * height)) as Quad;
  return {
    kind: "surface", progress, plane: toPx(quad), restPlane: toPx(plane), rect: { left, top, width: w, height: h },
    homography: absolute, placed, fitScale, lineBox: { width: line * width, height: lineHeight * height }, lines,
    clipToPlane: Boolean(text.surface), maskShapes, occluderTaps, opacity,
  };
}

/**
 * Which stacking group a title belongs to (see sceneLayers): 0 behind the presenter, 1 in front of
 * the presenter but behind its own tapped objects, 2 a plain title above every matte.
 */
export function titleGroup(text: Pick<TextOverlay, "behind" | "occluders">): 0 | 1 | 2 {
  return text.behind ? 0 : text.occluders?.length ? 1 : 2;
}

/** Titles bottom to top in the order sceneLayers draws them: by group, saved order within a group. For hit targets that must match what is drawn on top. */
export function stackTitles<T extends Pick<TextOverlay, "behind" | "occluders" | "passMs" | "passFadeMs">>(texts: readonly T[]): T[] {
  // A passing `behind` title (ADR 0055) draws after the other `behind` titles, above the shared presenter matte,
  // in groups ordered by their crossing.
  const passing = (text: T) => Boolean(text.behind && text.passMs !== undefined);
  const rank = (text: T) => titleGroup(text) * 2 + (passing(text) ? 1 : 0);
  const crossing = (a: T, b: T) => passing(a) && passing(b) ? a.passMs! - b.passMs! || (a.passFadeMs ?? PASS_FADE_MS) - (b.passFadeMs ?? PASS_FADE_MS) : 0;
  return texts.map((text, index) => ({ text, index })).sort((a, b) => rank(a.text) - rank(b.text) || crossing(a.text, b.text) || a.index - b.index).map((entry) => entry.text);
}

/** Default length of the crossing (ms) for a title with `passMs` (ADR 0055). */
export const PASS_FADE_MS = 160;

/**
 * How much of the presenter is drawn over a `behind` title at reel time `reelMs` (ADR 0055): 1 for a
 * plain `behind` title (she is always in front), and for one with `passMs`, 0 before it (the words cover
 * her, so she reads as behind them) ramping to 1 over `passFadeMs` (she has walked through the words).
 * A title that is not `behind` has no presenter over it, and `passMs` is ignored: 1, unaffected.
 * A pure function of the reel time; the renderer reads it from the frame, preview and export alike.
 */
export function passOpacity(text: Pick<TextOverlay, "behind" | "passMs" | "passFadeMs">, reelMs: number): number {
  if (!text.behind || text.passMs === undefined) return 1;
  const fade = text.passFadeMs ?? PASS_FADE_MS;
  if (fade <= 0) return reelMs >= text.passMs ? 1 : 0;
  return Math.min(1, Math.max(0, (reelMs - text.passMs) / fade));
}

/**
 * A presenter layer that belongs to one group of passing titles, those with the same crossing (passMs and
 * passFadeMs): their ids, the span of their windows (reel frames, end exclusive) and the crossing.
 */
export type PersonPass = { textIds: string[]; fromFrame: number; toFrame: number; passMs: number; passFadeMs: number };

/**
 * The opacity of a presenter layer on reel frame `reelFrame`: 1 for the shared presenter matte; for one
 * that belongs to a group of passing titles, `passOpacity` inside the span of their windows and 0 outside it, so it never
 * covers another title (the shared matte below does that for every other `behind` title).
 */
export function personLayerOpacity(layer: { pass?: PersonPass }, reelFrame: number, fps: number = REEL_FORMAT.fps): number {
  const pass = layer.pass;
  if (!pass) return 1;
  if (reelFrame < pass.fromFrame || reelFrame >= pass.toFrame) return 0;
  return passOpacity({ behind: true, passMs: pass.passMs, passFadeMs: pass.passFadeMs }, (reelFrame * 1000) / fps);
}

export type SceneLayer =
  | { kind: "title"; text: TextOverlay; from: number; durationInFrames: number }
  /**
   * The presenter matte of one clip, above every `behind` title on screen with it; or, with `pass`,
   * above one group of passing titles (same crossing), faded in at that crossing (`personLayerOpacity`).
   */
  | { kind: "person"; clipIndex: number; from: number; durationInFrames: number; pass?: PersonPass }
  /** The objects tapped for one title, on one clip, above that title. */
  | { kind: "object"; text: TextOverlay; clipIndex: number; from: number; durationInFrames: number };

/**
 * The bottom-to-top order of titles and their occluders on the reel:
 *   1. `behind` titles, each followed by the objects tapped for it;
 *   2. the presenter matte of every video clip a `behind` title overlaps (one per clip,
 *      so it is segmented once however many titles sit behind the presenter);
 *   2b. `behind` titles with `passMs` (ADR 0055), grouped by crossing and ordered by passMs:
 *      each group's titles and their objects, then one presenter matte for the group,
 *      faded in at its crossing (`personLayerOpacity`);
 *   3. titles with tapped objects but not `behind`, each followed by its objects;
 *   4. every other title (a foreground caption), on top of all mattes.
 * Within a group the saved order holds. Before ADR 0046 every matte sat above every
 * title, so a caption on a shot with a `behind` title had the presenter drawn over it.
 * `hasVideo` says whether a clip can be matted (the renderer checks its asset).
 */
export function sceneLayers(timeline: Timeline, fps: number = REEL_FORMAT.fps, hasVideo: (clip: Clip) => boolean = (clip) => clip.kind === "VIDEO"): SceneLayer[] {
  const plan = framePlan(timeline, fps);
  const clips = plan.clips.map((entry, clipIndex) => ({ ...entry, clipIndex, startMs: (entry.from * 1000) / fps, endMs: ((entry.from + entry.durationInFrames) * 1000) / fps }));
  const overlaps = (text: TextOverlay, clip: (typeof clips)[number]) => text.startMs < clip.endMs && text.endMs > clip.startMs;
  const objects = (text: TextOverlay): SceneLayer[] => text.occluders?.length
    ? clips.filter((clip) => hasVideo(clip.clip) && overlaps(text, clip)).map((clip) => ({ kind: "object", text, clipIndex: clip.clipIndex, from: clip.from, durationInFrames: clip.durationInFrames }))
    : [];
  const title = (entry: (typeof plan.texts)[number]): SceneLayer => ({ kind: "title", text: entry.text, from: entry.from, durationInFrames: entry.durationInFrames });
  const passes = (text: TextOverlay) => text.behind && text.passMs !== undefined;
  const behind = plan.texts.filter((entry) => titleGroup(entry.text) === 0 && !passes(entry.text));
  const passing = plan.texts.filter((entry) => titleGroup(entry.text) === 0 && passes(entry.text));
  const tapped = plan.texts.filter((entry) => titleGroup(entry.text) === 1);
  const plain = plan.texts.filter((entry) => titleGroup(entry.text) === 2);
  // Passing titles are grouped by their crossing (passMs, passFadeMs): one presenter matte above each group, faded
  // in at that crossing (ADR 0055). Groups go bottom to top by passMs, so a group's presenter covers only titles that
  // have already begun their own crossing, never one that is still in front of her.
  const groups = new Map<string, (typeof plan.texts)[number][]>();
  for (const entry of passing) {
    const key = `${entry.text.passMs}|${entry.text.passFadeMs ?? PASS_FADE_MS}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const passGroups = [...groups.values()].sort((a, b) => a[0].text.passMs! - b[0].text.passMs! || (a[0].text.passFadeMs ?? PASS_FADE_MS) - (b[0].text.passFadeMs ?? PASS_FADE_MS));
  const passGroup = (entries: (typeof plan.texts)[number][]): SceneLayer[] => {
    const first = entries[0].text;
    const pass: PersonPass = {
      textIds: entries.map((entry) => entry.text.id),
      fromFrame: Math.min(...entries.map((entry) => entry.from)),
      toFrame: Math.max(...entries.map((entry) => entry.from + entry.durationInFrames)),
      passMs: first.passMs!, passFadeMs: first.passFadeMs ?? PASS_FADE_MS,
    };
    const people = clips.filter((clip) => hasVideo(clip.clip) && entries.some((entry) => overlaps(entry.text, clip)))
      .map((clip): SceneLayer => ({ kind: "person", clipIndex: clip.clipIndex, from: clip.from, durationInFrames: clip.durationInFrames, pass }));
    return [...entries.flatMap((entry) => [title(entry), ...objects(entry.text)]), ...people];
  };
  return [
    ...behind.flatMap((entry) => [title(entry), ...objects(entry.text)]),
    // Every behind text of the reel, not just those with a plan entry, as before: a matte is mounted for the clip it overlaps.
    // A passing title has its own (below), so it does not mount the shared one.
    ...clips.filter((clip) => hasVideo(clip.clip) && timeline.texts.some((text) => text.behind && !passes(text) && overlaps(text, clip)))
      .map((clip): SceneLayer => ({ kind: "person", clipIndex: clip.clipIndex, from: clip.from, durationInFrames: clip.durationInFrames })),
    // Above the shared matte: a passing title must cover the presenter until its crossing, so nothing that always shows her may sit above it.
    ...passGroups.flatMap(passGroup),
    ...tapped.flatMap((entry) => [title(entry), ...objects(entry.text)]),
    ...plain.map(title),
  ];
}
