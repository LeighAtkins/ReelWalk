import { type FaceHint } from "../../lib/face-hint";
import { compositionToSource, pictureCanvasTransform, pictureRects, sourceToComposition, type ClipPicture, type XY } from "@reelwalk/core";

/**
 * Inspect mode's geometry (ADR 0057), free of the DOM so it can be tested.
 *
 * The view is a zoom and the composition point at the centre of the screen,
 * in composition fractions (ADR 0047's space), so it means the same region
 * whether the stage shows the Player (Final) or the source frame (Footage
 * only), and it does not move when the playhead steps a frame.
 *
 * Gesture points are in stage px: px from the top left of the composition's
 * own rectangle on screen (`.stage-plane`), with that rectangle's size.
 */

export const MIN_ZOOM = 1, MAX_ZOOM = 8;
/** Double-tap zooms to this, about the tap. */
export const TAP_ZOOM = 3;
/** Above this zoom the canvas shows source pixels as blocks unless Smooth is chosen. */
export const PIXELS_ABOVE = 4;

export type InspectView = { zoom: number; cx: number; cy: number };
export type StageSize = { width: number; height: number };
export type InspectLayer = "final" | "footage";
/** "auto" is smooth up to 4×, pixels above. */
export type Smoothing = "auto" | "smooth" | "pixels";

export const FULL_VIEW: InspectView = { zoom: 1, cx: 0.5, cy: 0.5 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Zoom within 1× and `max` (8× unless capped) and the centre kept so the view never leaves the frame. */
export function clampView(view: InspectView, max: number = MAX_ZOOM): InspectView {
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : 1, MIN_ZOOM, Math.min(MAX_ZOOM, max));
  const half = 0.5 / zoom;
  return { zoom, cx: clamp(view.cx, half, 1 - half), cy: clamp(view.cy, half, 1 - half) };
}

/** The part of the composition on screen, in composition fractions. */
export function visibleRect(view: InspectView): { u: number; v: number; width: number; height: number } {
  const size = 1 / view.zoom;
  return { u: view.cx - size / 2, v: view.cy - size / 2, width: size, height: size };
}

/** Takes stage px; returns the composition fraction shown there. */
export function stageToComposition(view: InspectView, x: number, y: number, stage: StageSize): XY {
  return [view.cx + (x / stage.width - 0.5) / view.zoom, view.cy + (y / stage.height - 0.5) / view.zoom];
}

/** Takes a composition fraction; returns where it is on the stage in stage px. */
export function compositionToStage(view: InspectView, u: number, v: number, stage: StageSize): XY {
  return [((u - view.cx) * view.zoom + 0.5) * stage.width, ((v - view.cy) * view.zoom + 0.5) * stage.height];
}

/** Zooms to `zoom`, keeping the composition point under stage px (x, y) where it is (as far as the frame edges allow). */
export function zoomAbout(view: InspectView, zoom: number, x: number, y: number, stage: StageSize): InspectView {
  const [u, v] = stageToComposition(view, x, y, stage);
  const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  return clampView({ zoom: next, cx: u - (x / stage.width - 0.5) / next, cy: v - (y / stage.height - 0.5) / next });
}

/** A drag of (dx, dy) stage px: the picture follows the finger. */
export function panBy(view: InspectView, dx: number, dy: number, stage: StageSize): InspectView {
  return clampView({ zoom: view.zoom, cx: view.cx - dx / stage.width / view.zoom, cy: view.cy - dy / stage.height / view.zoom });
}

const mid = (a: XY, b: XY): XY => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const distance = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Two fingers from `from` to `to` (stage px), starting at `start`: the zoom
 * scales with the spread, and the composition point that was under the
 * fingers' midpoint stays under it, so moving both fingers pans.
 */
export function pinchView(start: InspectView, from: [XY, XY], to: [XY, XY], stage: StageSize): InspectView {
  const spread = distance(from[0], from[1]);
  const zoom = clamp(spread > 0 ? (start.zoom * distance(to[0], to[1])) / spread : start.zoom, MIN_ZOOM, MAX_ZOOM);
  const [u, v] = stageToComposition(start, ...mid(from[0], from[1]), stage);
  const [x, y] = mid(to[0], to[1]);
  return clampView({ zoom, cx: u - (x / stage.width - 0.5) / zoom, cy: v - (y / stage.height - 0.5) / zoom });
}

/** Double-tap: 1× → 3× about the tap; anything zoomed → back to the whole frame. */
export function doubleTapView(view: InspectView, x: number, y: number, stage: StageSize): InspectView {
  return view.zoom > 1.05 ? FULL_VIEW : zoomAbout(view, TAP_ZOOM, x, y, stage);
}

/** A wheel or trackpad pinch of `deltaY` px about the cursor (negative zooms in). */
export function wheelView(view: InspectView, deltaY: number, x: number, y: number, stage: StageSize): InspectView {
  return zoomAbout(view, view.zoom * Math.exp(-clamp(deltaY, -200, 200) * 0.002), x, y, stage);
}

/**
 * The 2D matrix (a, b, c, d, e, f) from the unzoomed stage (the whole
 * composition drawn `width`×`height`) to the zoomed one. As CSS, with the
 * transform origin at the composition's top left; as a canvas transform, for
 * a canvas of the stage's size.
 */
export function viewMatrix(view: InspectView, width: number, height: number): [number, number, number, number, number, number] {
  const { u, v } = visibleRect(view);
  return [view.zoom, 0, 0, view.zoom, -u * view.zoom * width, -v * view.zoom * height];
}

/** "4×", "2.5×". */
export function zoomLabel(zoom: number): string {
  const rounded = Math.round(zoom * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}×`;
}

/** Whether the picture is drawn smoothed: smooth up to 4×, source pixels as blocks above, unless chosen. */
export function smoothAt(zoom: number, smoothing: Smoothing): boolean {
  return smoothing === "auto" ? zoom <= PIXELS_ABOVE : smoothing === "smooth";
}

/** The Pixels/Smooth button: switches to the opposite of what is shown now. */
export function toggleSmoothing(zoom: number, smoothing: Smoothing): Smoothing {
  return smoothAt(zoom, smoothing) ? "pixels" : "smooth";
}

/** One frame back or on from `ms` on the reel's frame grid (the Player rounds to whole frames), kept inside the reel. */
export function stepFrameMs(ms: number, direction: -1 | 1, totalMs: number, fps: number): number {
  const frame = Math.round((ms * fps) / 1000) + direction;
  const last = Math.max(0, Math.floor(((totalMs - 1) * fps) / 1000));
  return (clamp(frame, 0, last) * 1000) / fps;
}

/**
 * The deepest zoom a layer allows on this screen. Final magnifies the Player
 * itself, so the browser rasterises a layer the zoomed size: at 8× on a 3×
 * screen a 324 px stage is about 7800×13800 device px (more with a taller
 * stage), past what phones give one layer. Final stops at 4× there; Footage
 * only draws into a screen-sized canvas and keeps 8×.
 */
export function zoomCap(layer: InspectLayer, devicePixelRatio: number): number {
  return layer === "final" && devicePixelRatio >= 3 ? 4 : MAX_ZOOM;
}

// ── State ───────────────────────────────────────────────────────

export type InspectState = { view: InspectView; layer: InspectLayer; smoothing: Smoothing };
export type InspectAction =
  /** `max` is the layer's zoom cap on this screen (`zoomCap`). */
  | { type: "view"; view: InspectView; max?: number }
  | { type: "reset" }
  | { type: "layer"; layer: InspectLayer; max?: number }
  | { type: "smoothing" };

export const INITIAL_INSPECT: InspectState = { view: FULL_VIEW, layer: "final", smoothing: "auto" };

/**
 * Inspect's state. The view belongs to neither layer, so switching layer or
 * stepping a frame (a seek, outside this state) shows the same region.
 */
export function inspectReducer(state: InspectState, action: InspectAction): InspectState {
  switch (action.type) {
    case "view": return { ...state, view: clampView(action.view, action.max) };
    case "reset": return { ...state, view: FULL_VIEW };
    // Into a layer with a lower cap, the view comes down to it about its own centre.
    case "layer": return { ...state, layer: action.layer, view: clampView(state.view, action.max) };
    case "smoothing": return { ...state, smoothing: toggleSmoothing(state.view.zoom, state.smoothing) };
  }
}

// ── The source frame on the stage ───────────────────────────────

/** The subset of CanvasRenderingContext2D drawing uses. */
export type InspectContext = Pick<CanvasRenderingContext2D, "setTransform" | "transform" | "fillRect" | "drawImage"> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
};

/**
 * Draws the source frame (`source`, at the source's own size) into a
 * `width`×`height` canvas of the stage under `view`: through the clip's fit,
 * zoom and camera move (ADR 0047's `pictureCanvasTransform`, the
 * composition's own placement), then the inspect zoom. The source is drawn
 * straight to the screen's pixels, so 8× shows the source's own detail, not
 * an enlarged 1080×1920 copy, and only the visible region is read, so 8×
 * of a 4K frame costs a screen's worth of pixels. Black where the frame shows no picture; no
 * grade and no Fit backdrop: these are the pixels that were delivered.
 */
export function drawSourceView(ctx: InspectContext, source: CanvasImageSource, picture: ClipPicture, view: InspectView, width: number, height: number, smooth: boolean): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = "high";
  ctx.setTransform(...viewMatrix(view, width, height));
  ctx.transform(...pictureCanvasTransform(picture, width, height));
  const r = pictureRects(picture), k = width / picture.frame.width;
  // Only the source px on screen (a pixel more each side for smoothing at the edges), scaled once to the screen.
  const shown = visibleSourceRect(picture, view);
  const x0 = Math.max(r.sx, Math.floor(shown.sx) - 1), y0 = Math.max(r.sy, Math.floor(shown.sy) - 1);
  const x1 = Math.min(r.sx + r.sw, Math.ceil(shown.sx + shown.sw) + 1), y1 = Math.min(r.sy + r.sh, Math.ceil(shown.sy + shown.sh) + 1);
  if (x1 <= x0 || y1 <= y0) return;
  const fx = (r.dw * k) / r.sw, fy = (r.dh * k) / r.sh;
  ctx.drawImage(source, x0, y0, x1 - x0, y1 - y0, r.dx * k + (x0 - r.sx) * fx, r.dy * k + (y0 - r.sy) * fy, (x1 - x0) * fx, (y1 - y0) * fy);
}

/** The source px on screen under `view`: the stage's top left maps to (sx, sy), its bottom right to (sx + sw, sy + sh). */
export function visibleSourceRect(picture: ClipPicture, view: InspectView): { sx: number; sy: number; sw: number; sh: number } {
  const { u, v, width, height } = visibleRect(view);
  const [x0, y0] = compositionToSource(picture, u, v);
  const [x1, y1] = compositionToSource(picture, u + width, v + height);
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

// ── The presenter's face ────────────────────────────────────────

// The gate's stored face, read in lib so the worker image (which copies apps/web/lib only) can load the library code.
export { faceHintFromChecks, type FaceHint } from "../../lib/face-hint";

/** How much of the view's height the face fills after the Face chip. */
const FACE_SHARE = 0.4;

/**
 * The view the Face chip jumps to: the stored face box, or a face of the
 * stored height at the top-third centre where the presenter kit frames her
 * ("head about a quarter of the way down"), or that point at 4× with nothing
 * stored. Source fractions go through the clip's fit, zoom and move.
 */
export function faceView(hint: FaceHint | null, picture: ClipPicture): InspectView {
  const W = picture.sourceWidth, H = picture.sourceHeight;
  const centre: XY = hint?.box ? [((hint.box.x0 + hint.box.x1) / 2) * W, ((hint.box.y0 + hint.box.y1) / 2) * H] : [0.5 * W, 0.25 * H];
  const [cx, cy] = sourceToComposition(picture, centre[0], centre[1]);
  let zoom = 4;
  if (hint?.heightFraction) {
    const h = hint.heightFraction * H;
    const shown = sourceToComposition(picture, centre[0], centre[1] + h / 2)[1] - sourceToComposition(picture, centre[0], centre[1] - h / 2)[1];
    if (shown > 0) zoom = clamp(FACE_SHARE / shown, 2, MAX_ZOOM);
  }
  return clampView({ zoom, cx, cy });
}

/** `reelwalk-inspect-0m01.233s-4x-footage.png`: the reel time, zoom and layer, safe as a file name everywhere. */
export function inspectFileName(reelMs: number, zoom: number, layer: InspectLayer): string {
  const minutes = Math.floor(reelMs / 60_000), seconds = (reelMs - minutes * 60_000) / 1000;
  return `reelwalk-inspect-${minutes}m${seconds.toFixed(3).padStart(6, "0")}s-${zoomLabel(zoom).replace("×", "x")}-${layer}.png`;
}
