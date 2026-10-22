import { clipPicture, pictureCanvasTransform, pictureRects, type Clip, type ClipMoment, type PixelSize } from "@reelwalk/core";

/**
 * Drawing a clip's frame as the composition places it (ADR 0047). Kept free
 * of DOM globals and of the render package so it can be unit-tested with a
 * recording context.
 */

/** Composition width the canvas sizes are relative to. */
export const COMPOSITION_WIDTH = 1080;

/** Flat mid grey: no gradient, so neither the tracker nor the surface finder can find anything outside the picture. */
export const ANALYSIS_FILL = "#808080";

/** The subset of CanvasRenderingContext2D the drawing uses. */
export type DrawContext = Pick<CanvasRenderingContext2D, "setTransform" | "fillRect" | "drawImage" | "save" | "restore"> & { filter: string; fillStyle: string | CanvasGradient | CanvasPattern };

export type DrawPurpose =
  /** What the viewer sees, for the loupe: the Fit backdrop and the colour grade where the browser can filter a canvas. */
  | { kind: "view"; grade: string; canFilter: boolean }
  /**
   * For surface detection and tracking: only the picture, through its fit,
   * zoom and move, on flat grey. The Fit backdrop moves at a different rate
   * from the picture (and is black where canvas filters are missing), so
   * points found on it would bend the plane, differently per browser. No
   * grade either, so every browser analyses the same pixels.
   */
  | { kind: "analysis" };

/**
 * Draws `media` (already at the right frame, `source` px in size) into a
 * `width`×`height` canvas of the composition the way ReelComposition's
 * ClipView shows `clip` at `moment`. Whips and fades are transitions and are
 * not drawn; nor is lens softness (a follow-up).
 */
export function drawClipFrame(ctx: DrawContext, media: CanvasImageSource, source: PixelSize, clip: Pick<Clip, "fit" | "zoom" | "motion" | "camera">, moment: ClipMoment, width: number, height: number, purpose: DrawPurpose): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.fillStyle = purpose.kind === "analysis" ? ANALYSIS_FILL : "#000";
  ctx.fillRect(0, 0, width, height);
  if (!source.width || !source.height) return;
  const k = width / COMPOSITION_WIDTH;
  const view = purpose.kind === "view" ? purpose : null;
  if (view && clip.fit === "contain" && view.canFilter) {
    // ClipView: <AbsoluteFill style="filter: blur(48px) brightness(0.7); transform: scale(1.25)"> with the picture covering it.
    const cover = pictureRects(clipPicture({ fit: "cover", zoom: 1, motion: "none" }, source, moment));
    ctx.save();
    ctx.filter = `${view.grade} blur(${48 * k}px) brightness(0.7)`.trim();
    ctx.setTransform(1.25, 0, 0, 1.25, width / 2 - 1.25 * (width / 2), height / 2 - 1.25 * (height / 2));
    ctx.drawImage(media, cover.sx, cover.sy, cover.sw, cover.sh, cover.dx * k, cover.dy * k, cover.dw * k, cover.dh * k);
    ctx.restore();
  }
  const picture = clipPicture(clip, source, moment);
  const r = pictureRects(picture);
  ctx.save();
  if (view?.canFilter && view.grade) ctx.filter = view.grade;
  ctx.setTransform(...pictureCanvasTransform(picture, width, height));
  ctx.drawImage(media, r.sx, r.sy, r.sw, r.sh, r.dx * k, r.dy * k, r.dw * k, r.dh * k);
  ctx.restore();
}
