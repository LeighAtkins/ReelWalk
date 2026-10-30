import { clipCameraAt, locateFrame, type CameraClip } from "./cinematic";
import { clipSourceFrame } from "./frames";
import { applyHomography, homography, type Quad } from "./motion";
import { clipDurationMs, clipOffsetMsAtSource, clipSourceMsAt, framePlan, REEL_FORMAT, type Clip, type Timeline } from "./timeline";

/**
 * One frame-and-coordinate contract for everything that places things on the
 * picture (ADR 0047): analysis, the loupe, the editor's handles and the
 * composition. Four spaces, and every function here names the one it takes
 * and the one it returns:
 *
 * - **source px**: pixels of the clip's own video or photo, (0,0) top left,
 *   up to its intrinsic width and height.
 * - **composition fraction**: the 9:16 reel frame as 0..1 on each axis. Text
 *   x/y, surfaces, pins, posts, cut-outs and taps are stored in this space.
 * - **viewport px**: CSS pixels on screen (pointer clientX/clientY). Needs the
 *   stage rect: where the composition is actually drawn, which is the
 *   Player's contain-fit inside its box, not the box itself (slip 60).
 * - **plane-local**: a point on a surface, either as (s,t) in the unit square
 *   of its quad, or carried between the first frame's plane and this frame's.
 *
 * Pure and DOM-free, so core (scene evaluation), render and web share it.
 */

export type PictureFit = "cover" | "contain";
export type PixelSize = { width: number; height: number };
/** A rectangle in viewport px. */
export type ViewportRect = { left: number; top: number; width: number; height: number };
export type XY = [number, number];

/** The source rectangle to draw and the destination rectangle to draw it into. */
export type FitRects = { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number };

/**
 * Where a video of `sourceWidth`×`sourceHeight` lands in a `width`×`height`
 * frame under `object-fit`, as the source rectangle to draw and the
 * destination rectangle to draw it into. The matte draws the person through
 * the same geometry as the footage, so neither is stretched.
 *
 * Takes source px and destination px; returns source px (s*) and destination px (d*).
 */
export function fitRects(sourceWidth: number, sourceHeight: number, width: number, height: number, fit: PictureFit): FitRects {
  const scale = fit === "cover" ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight);
  const dw = sourceWidth * scale, dh = sourceHeight * scale;
  if (fit === "cover") {
    const sw = width / scale, sh = height / scale;
    return { sx: (sourceWidth - sw) / 2, sy: (sourceHeight - sh) / 2, sw, sh, dx: 0, dy: 0, dw: width, dh: height };
  }
  return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh };
}

// ── The clip's picture in the composition ───────────────────────

/**
 * How a clip's picture sits in the composition at one moment: its fit, and
 * the zoom and camera move the composition applies as
 * `scale(scale) translateX(shiftX·100%)` about the centre (presentation.ts
 * `motionTransform`). Fades and whips are transitions, not placement, and are
 * left out.
 */
export type ClipPicture = {
  sourceWidth: number;
  sourceHeight: number;
  fit: PictureFit;
  /** Zoom times the camera move's scale. */
  scale: number;
  /** The camera move's sideways shift, as a fraction of the frame width (before scaling). */
  shiftX: number;
  /** The camera move's vertical shift, as a fraction of the frame height (before scaling); 0 for the Ken Burns presets. */
  shiftY: number;
  /** The frame the picture is fitted into, in composition px. */
  frame: PixelSize;
};

/** Where a clip is in its own playback: `progress` 0..1 as the composition computes it, and seconds since it started. */
export type ClipMoment = { progress: number; seconds: number; /** The reel's opening shot: its eased move is read already in progress (ADR 0067). */ opening?: boolean };

/**
 * The moment of a clip at `sourceMs` of its source, as the composition sees
 * it (presentation.ts: progress = frame / (durationInFrames − 1)). Pass the
 * clip's `durationInFrames` from `framePlan` when the timeline is at hand;
 * otherwise it is taken from the clip's own length.
 *
 * Takes source ms; returns a clip moment.
 */
export function clipMomentAtSource(clip: Pick<Clip, "kind" | "speed" | "sourceStartMs" | "sourceEndMs">, sourceMs: number, fps: number = REEL_FORMAT.fps, durationInFrames?: number): ClipMoment {
  const frames = durationInFrames ?? Math.max(1, Math.round((clipDurationMs(clip as Clip) * fps) / 1000));
  // Along the ramp when the clip has one (ADR 0067); linear otherwise.
  const frame = clipOffsetMsAtSource(clip as Clip, Math.max(clip.sourceStartMs, sourceMs)) * (fps / 1000);
  return { progress: frames > 1 ? Math.min(1, Math.max(0, frame / (frames - 1))) : 0, seconds: Math.max(0, frame / fps) };
}

/**
 * What is on screen at `reelMs`: the clip (by frame-rounded plan, like the
 * composition), the source time and the moment. `mediaMs` is the time the
 * composition's media element is actually at: Remotion trims on whole frames
 * (trimBefore = round(sourceStartMs·fps)), so it can differ from `sourceMs`
 * by up to half a frame; read pixels at `mediaMs` to see the stage's frame.
 */
export type OnScreen = { index: number; clip: Clip; sourceMs: number; mediaMs: number; moment: ClipMoment };

/** Takes reel ms; returns the clip on screen with its source ms and moment, or null past the end. */
export function onScreenAt(timeline: Timeline, reelMs: number, fps: number = REEL_FORMAT.fps): OnScreen | null {
  const at = locateFrame(timeline, reelMs, fps);
  if (!at) return null;
  const clip = timeline.clips[at.index];
  const sourceMs = clipSourceMsAt(clip, at.offsetMs);
  const frames = framePlan(timeline, fps).clips[at.index].durationInFrames;
  // The same maths the composition's media uses (frames.ts), so the loupe reads the frame the stage shows.
  const mediaMs = (clipSourceFrame(clip, (at.offsetMs * fps) / 1000, frames, fps) * 1000) / fps;
  return { index: at.index, clip, sourceMs, mediaMs, moment: { ...clipMomentAtSource(clip, sourceMs, fps, frames), opening: at.index === 0 } };
}

/** Takes a clip, its source size in px and a moment; returns how its picture sits in the composition then. */
export function clipPicture(clip: CameraClip & Pick<Clip, "fit" | "zoom">, source: PixelSize, moment: ClipMoment, frame: PixelSize = REEL_FORMAT): ClipPicture {
  const move = clipCameraAt(clip, moment.progress, moment.seconds, moment.opening);
  return { sourceWidth: source.width, sourceHeight: source.height, fit: clip.headLock ? "cover" : clip.fit, scale: (clip.headLock ? 1 : clip.zoom || 1) * move.scale, shiftX: move.x / 100, shiftY: move.y / 100, frame: { width: frame.width, height: frame.height } };
}

/** The picture's fit rectangles in composition px (before zoom and motion). */
export function pictureRects(picture: ClipPicture): FitRects {
  return fitRects(picture.sourceWidth, picture.sourceHeight, picture.frame.width, picture.frame.height, picture.fit);
}

/** Takes source px; returns composition fraction (where that source pixel is shown; may fall outside 0..1 when cropped). */
export function sourceToComposition(picture: ClipPicture, px: number, py: number): XY {
  const r = pictureRects(picture);
  const u0 = (r.dx + ((px - r.sx) * r.dw) / r.sw) / picture.frame.width;
  const v0 = (r.dy + ((py - r.sy) * r.dh) / r.sh) / picture.frame.height;
  return [0.5 + picture.scale * (u0 - 0.5 + picture.shiftX), 0.5 + picture.scale * (v0 - 0.5 + picture.shiftY)];
}

/** Takes composition fraction; returns source px (may fall outside the source where the frame shows no picture). */
export function compositionToSource(picture: ClipPicture, u: number, v: number): XY {
  const r = pictureRects(picture);
  const u0 = (u - 0.5) / picture.scale + 0.5 - picture.shiftX;
  const v0 = (v - 0.5) / picture.scale + 0.5 - picture.shiftY;
  return [r.sx + ((u0 * picture.frame.width - r.dx) * r.sw) / r.dw, r.sy + ((v0 * picture.frame.height - r.dy) * r.sh) / r.dh];
}

/**
 * The 2D canvas transform (a, b, c, d, e, f) that draws the picture into a
 * `width`×`height` canvas of the composition: apply it, then draw the source
 * rectangle `pictureRects` names into its destination scaled by
 * `width / frame.width`. Same matrix as the composition's CSS transform.
 *
 * Takes canvas px; returns a canvas transform (canvas px → canvas px).
 */
export function pictureCanvasTransform(picture: ClipPicture, width: number, height: number): [number, number, number, number, number, number] {
  const s = picture.scale, tx = picture.shiftX * width, ty = picture.shiftY * height;
  // p' = c + s·(p − c + t)
  return [s, 0, 0, s, width / 2 + s * (tx - width / 2), height / 2 + s * (ty - height / 2)];
}

// ── The composition on screen ───────────────────────────────────

/**
 * Where the composition is drawn inside a box on screen: contain-fitted and
 * centred, as the Remotion Player draws it. The stage box can be wider or
 * taller than 9:16 (full screen on a phone is), and handles placed by the
 * box's own fractions then miss the picture (slip 60).
 *
 * Takes the box in viewport px; returns the stage rect in viewport px.
 */
export function stageRect(box: ViewportRect, frame: PixelSize = REEL_FORMAT): ViewportRect {
  const r = fitRects(frame.width, frame.height, box.width, box.height, "contain");
  return { left: box.left + r.dx, top: box.top + r.dy, width: r.dw, height: r.dh };
}

/** Viewport px per composition px on this stage (what text is scaled by to show at preview size). */
export function compositionScale(stage: ViewportRect, frame: PixelSize = REEL_FORMAT): number {
  return stage.width / frame.width;
}

/** Takes composition fraction; returns viewport px. */
export function compositionToViewport(stage: ViewportRect, u: number, v: number): XY {
  return [stage.left + u * stage.width, stage.top + v * stage.height];
}

/** Takes viewport px; returns composition fraction (unclamped). */
export function viewportToComposition(stage: ViewportRect, x: number, y: number): XY {
  return [(x - stage.left) / stage.width, (y - stage.top) / stage.height];
}

// ── Planes ──────────────────────────────────────────────────────

/**
 * A tracked plane's motion between the frame it was set on and this frame:
 * `toNow` carries a stored (first-frame) composition fraction to where it is
 * shown now, `toFirst` brings a displayed one back to be stored. Identity
 * without a pin, on the first frame, or when the quads are degenerate.
 */
export type PlaneMotion = { toNow(u: number, v: number): XY; toFirst(u: number, v: number): XY };
export const STILL_PLANE: PlaneMotion = { toNow: (u, v) => [u, v], toFirst: (u, v) => [u, v] };

/** Takes the first frame's quad and this frame's quad (composition fractions, tl tr br bl); returns the plane's motion between them. */
export function planeMotion(first: readonly number[] | null | undefined, now: readonly number[] | null | undefined): PlaneMotion {
  if (!first || !now || first.length !== 8 || now.length !== 8) return STILL_PLANE;
  const H = homography(first as Quad, now as Quad);
  const back = H ? homography(now as Quad, first as Quad) : null;
  if (!H || !back) return STILL_PLANE;
  return { toNow: (u, v) => applyHomography(H, u, v), toFirst: (u, v) => applyHomography(back, u, v) };
}

/** Takes a flat list of composition fractions (x0, y0, x1, y1, …); returns them carried by `map`, same layout. */
export function mapPoints(points: readonly number[], map: (u: number, v: number) => XY): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push(...map(points[i], points[i + 1]));
  return out;
}

/** A quad's own coordinates: plane-local (s,t) in the unit square ↔ composition fraction. Null for a degenerate quad. */
export type PlaneFrame = { toComposition(s: number, t: number): XY; toPlane(u: number, v: number): XY };

/** Takes a quad in composition fractions (tl tr br bl); returns its plane-local frame. */
export function planeFrame(quad: readonly number[]): PlaneFrame | null {
  if (quad.length !== 8) return null;
  const unit: Quad = [0, 0, 1, 0, 1, 1, 0, 1];
  const H = homography(unit, quad as Quad);
  const back = H ? homography(quad as Quad, unit) : null;
  if (!H || !back) return null;
  return { toComposition: (s, t) => applyHomography(H, s, t), toPlane: (u, v) => applyHomography(back, u, v) };
}

/** Rounds stored coordinates the way the timeline keeps them (four decimals). */
export function storedFraction(value: number): number {
  return Number(value.toFixed(4));
}

// ── Placement versions ──────────────────────────────────────────

/**
 * Everything that decides where a title's plane is and what tracking it
 * would produce: its own placement (spot, surface, timing, stored lean, the
 * words that size a box pin) and the shot it starts on (which footage, which
 * part of it, how it is fitted, zoomed and moved, and where the shot starts).
 * A track captures this when it starts and applies its result only if it is
 * unchanged when the result arrives (ADR 0047): a corner dragged or a clip
 * trimmed meanwhile means the result answers a question nobody is asking now.
 * Posts are left out: they cut the title, they do not move its plane, so a
 * post dragged during a track keeps the track. A lean set in the Pin sheet
 * but not yet stored is the sheet's to add.
 *
 * Takes a timeline and a text id; returns an opaque version string ("" when the text is gone).
 */
export function placementVersion(timeline: Timeline, textId: string): string {
  const text = timeline.texts.find((item) => item.id === textId);
  if (!text) return "";
  let start = 0, clip: Clip | null = null;
  for (const candidate of timeline.clips) {
    const length = clipDurationMs(candidate);
    if (text.startMs < start + length) { clip = candidate; break; }
    start += length;
  }
  return JSON.stringify([
    text.x, text.y, text.surface ?? null, text.startMs, text.endMs, text.pin?.quad ?? null, text.pin?.lean ?? null,
    text.text, text.size, text.style, text.font ?? null, text.tracking ?? null,
    clip ? [clip.id, clip.assetId, clip.kind, clip.sourceStartMs, clip.sourceEndMs, clip.speed, clip.fit, clip.zoom, clip.motion, start, clip.ramp ?? null, clip.camera ?? null] : null,
  ]);
}

/**
 * The middle of the composition frame that `ms` falls in. Seeking a video to
 * a frame's start can land on the previous frame (33 ms is before 33.33 ms);
 * the middle is safely inside it. Exact for sources at the composition's
 * frame rate; for others it stays within the same composition frame.
 *
 * Takes media ms; returns media ms.
 */
export function midFrameMs(ms: number, fps: number = REEL_FORMAT.fps): number {
  // The tolerance (a thousandth of a frame) absorbs times rounded to the hundredth of a ms.
  return ((Math.floor((ms * fps) / 1000 + 1e-3) + 0.5) * 1000) / fps;
}
