import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from "remotion";
import type { Clip } from "@reelwalk/core";
import { FILTER_CSS } from "./look";
import type { ReelAsset } from "./types";
import { blend, boundingBox, grow, guidedFilter, paste, resample, toAlpha, type Mask } from "./matte-refine";
import { clipPresentation, fitRects } from "./presentation";

/**
 * People in the shot pass in front of the type (ADR 0039). A second decode
 * of the clip is stepped to the current frame, run through MediaPipe's
 * selfie segmenter, and only the person pixels are drawn above the text
 * layer, through the same fit, zoom, motion and transition as the footage,
 * so the cut-out sits exactly on the body (review of 2026-10-20).
 *
 * Every frame's matte depends only on that frame and the one before it,
 * never on what this page happened to render earlier: the previous frame's
 * mask is taken from a cache when it was just computed, and computed from
 * the footage otherwise. Rendering pages in parallel, seeking in the editor
 * and retrying a frame all give the same pixels.
 *
 * In an export, a matte that cannot load or cannot segment fails the render
 * rather than quietly leaving the words on top of the presenter.
 */

// In the editor the app's CSP allows scripts from its own origin only, so the
// web app serves these paths by rewrite; the render's headless Chrome has no
// CSP and reads the CDNs directly.
const CDN = { wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm", model: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite" };
const SAME_ORIGIN = { wasm: "/mediapipe/wasm", model: "/mediapipe/selfie_segmenter.tflite" };

type Segmenter = { segment(image: CanvasImageSource): { confidenceMasks?: { width: number; height: number; getAsFloat32Array(): Float32Array; close(): void }[]; close(): void } };
let loading: Promise<Segmenter> | null = null;

function loadSegmenter(isRendering: boolean): Promise<Segmenter> {
  const from = isRendering ? CDN : SAME_ORIGIN;
  loading ??= (async () => {
    const vision = await import("@mediapipe/tasks-vision");
    const files = await vision.FilesetResolver.forVisionTasks(from.wasm);
    return vision.ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: from.model },
      runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false,
    }) as unknown as Segmenter;
  })().catch((error) => { loading = null; throw error; });
  return loading;
}

/** Working size for the matte's edge work: a quarter of the pixels, upscaled at the end; the model's own grid is coarser still. */
export const WORK_WIDTH = 540, WORK_HEIGHT = 960;
/** How much of the previous frame's mask is kept, to settle the edge between frames. */
const SETTLE = 0.35;

export type MatteScratch = { work: HTMLCanvasElement; crop: HTMLCanvasElement; /** The unblended mask of the frame named by `rawKey`, for the next frame to settle against. */ raw: Mask | null; rawKey: string | null };

export function newScratch(): MatteScratch {
  return { work: document.createElement("canvas"), crop: document.createElement("canvas"), raw: null, rawKey: null };
}

function segmentToMask(segmenter: Segmenter, source: CanvasImageSource, width: number, height: number): Mask | null {
  const result = segmenter.segment(source);
  const mask = result.confidenceMasks?.[0];
  if (!mask) { result.close(); return null; }
  const copy = new Float32Array(mask.getAsFloat32Array());
  const out = resample({ data: copy, width: mask.width, height: mask.height }, width, height);
  result.close();
  return out;
}

type Fit = ReturnType<typeof fitRects>;

/** Draws the frame into the work canvas through the clip's fit geometry (what the footage shows, at a quarter size). */
export function drawWork(frame: CanvasImageSource, scratch: MatteScratch, fit: Fit, width: number, height: number): CanvasRenderingContext2D {
  scratch.work.width = WORK_WIDTH; scratch.work.height = WORK_HEIGHT;
  const wctx = scratch.work.getContext("2d", { willReadFrequently: true })!;
  wctx.clearRect(0, 0, WORK_WIDTH, WORK_HEIGHT);
  const kx = WORK_WIDTH / width, ky = WORK_HEIGHT / height;
  wctx.drawImage(frame, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx * kx, fit.dy * ky, fit.dw * kx, fit.dh * ky);
  return wctx;
}

/**
 * The person in `frame` as a soft mask at working size, before any settling:
 * the segmenter on the whole picture, again on a crop around the person for
 * four times the detail, snapped to the picture's edges (guided filter) and
 * grown one pixel so thin parts (a raised hand, hair ends) are covered. Two
 * pixels, with a low alpha floor, drew a halo of the wall behind her over the
 * words around the hair (snow reel, 2026-10-21).
 * Pure in the frame: the same picture always gives the same mask.
 */
export function personMask(segmenter: Segmenter, frame: CanvasImageSource, scratch: MatteScratch, fit: Fit, width: number, height: number): Mask | null {
  const wctx = drawWork(frame, scratch, fit, width, height);
  let mask = segmentToMask(segmenter, scratch.work, WORK_WIDTH, WORK_HEIGHT);
  if (!mask) return null;
  const box = boundingBox(mask, 0.5);
  if (box) {
    const padX = (box.x1 - box.x0) * 0.15, padY = (box.y1 - box.y0) * 0.1;
    const x0 = Math.max(0, Math.floor(box.x0 - padX)), y0 = Math.max(0, Math.floor(box.y0 - padY));
    const x1 = Math.min(WORK_WIDTH, Math.ceil(box.x1 + padX)), y1 = Math.min(WORK_HEIGHT, Math.ceil(box.y1 + padY));
    const cw = x1 - x0, ch = y1 - y0;
    if (cw > 16 && ch > 16 && cw * ch < WORK_WIDTH * WORK_HEIGHT * 0.6) {
      scratch.crop.width = cw; scratch.crop.height = ch;
      scratch.crop.getContext("2d")!.drawImage(scratch.work, x0, y0, cw, ch, 0, 0, cw, ch);
      const fine = segmentToMask(segmenter, scratch.crop, cw, ch);
      if (fine) mask = paste(fine, WORK_WIDTH, WORK_HEIGHT, x0, y0);
    }
  }
  const pixels = wctx.getImageData(0, 0, WORK_WIDTH, WORK_HEIGHT).data;
  const guide = new Float32Array(WORK_WIDTH * WORK_HEIGHT);
  for (let i = 0; i < guide.length; i++) guide[i] = (0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]) / 255;
  return grow(guidedFilter(mask, guide, 5, 2e-3), 1);
}

/** Draws `frame` into `out` through the clip's fit, keeping only the pixels `mask` (at working size) calls a person. */
export function compositePerson(frame: CanvasImageSource, out: HTMLCanvasElement, scratch: MatteScratch, mask: Mask, fit: Fit) {
  const ctx = out.getContext("2d")!;
  ctx.clearRect(0, 0, out.width, out.height);
  const wctx = scratch.work.getContext("2d", { willReadFrequently: true })!;
  // The edge ramps over the middle of the segmenter's confidence: a floor near zero kept the background around the hair.
  const alpha = toAlpha(mask, 0.35, 0.65);
  const image = wctx.createImageData(WORK_WIDTH, WORK_HEIGHT);
  for (let i = 0; i < alpha.length; i++) image.data[i * 4 + 3] = alpha[i];
  wctx.putImageData(image, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(frame, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx, fit.dy, fit.dw, fit.dh);
  ctx.globalCompositeOperation = "destination-in";
  ctx.filter = "blur(0.8px)";
  ctx.drawImage(scratch.work, 0, 0, out.width, out.height);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
}

/**
 * The matte for the frame named `key`: its own mask settled against the
 * previous frame's (`previousKey`), which is reused when it was the last one
 * computed and otherwise comes from `previousFrame`. Deterministic: the result
 * depends on those two pictures and nothing else.
 */
export function drawPersonOnly(segmenter: Segmenter, frame: CanvasImageSource, out: HTMLCanvasElement, scratch: MatteScratch, key: string, previous: { key: string; frame: CanvasImageSource } | null, fit: Fit, width: number, height: number): boolean {
  let before: Mask | null = null;
  if (previous) {
    before = scratch.rawKey === previous.key ? scratch.raw : personMask(segmenter, previous.frame, scratch, fit, width, height);
  }
  const now = personMask(segmenter, frame, scratch, fit, width, height);
  if (!now) return false;
  scratch.raw = now; scratch.rawKey = key;
  compositePerson(frame, out, scratch, before ? blend(now, before, SETTLE) : now, fit);
  return true;
}

/** Steps a decode to `seconds` and resolves once it holds that picture (readyState ≥ 2). */
export function frameAt(element: HTMLVideoElement, seconds: number, fps: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error(element.error ? `video error ${element.error.code}` : "video error")); };
    const cleanup = () => { element.removeEventListener("seeked", done); element.removeEventListener("loadeddata", done); element.removeEventListener("error", failed); };
    element.addEventListener("error", failed, { once: true });
    if (Math.abs(element.currentTime - seconds) < 1 / (fps * 2)) {
      // Already at this time (the first frame of a take, before the file has loaded): setting currentTime
      // again fires no `seeked`, so wait for the picture instead of a seek.
      if (element.readyState >= 2) done();
      else element.addEventListener("loadeddata", done, { once: true });
    } else {
      element.addEventListener("seeked", done, { once: true });
      element.currentTime = seconds;
    }
  });
}

/** A still copy of the decode's current picture, so two frames can be held at once. */
function snapshot(element: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = element.videoWidth; canvas.height = element.videoHeight;
  canvas.getContext("2d")!.drawImage(element, 0, 0);
  return canvas;
}

export const PersonMatteView: React.FC<{ clip: Clip; asset: ReelAsset; durationInFrames: number; fadeOut?: boolean; whipOut?: Clip["whipDirection"] | null }> = ({ clip, asset, durationInFrames, fadeOut = false, whipOut = null }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const scratch = useRef<MatteScratch | null>(null);
  const [segmenter, setSegmenter] = useState<Segmenter | null>(null);
  const [failed, setFailed] = useState(false);

  // In an export a matte that cannot be made fails the render; in the editor the words show over the person, with a note in the console.
  const fatal = (what: string, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    if (isRendering) cancelRender(new Error(`Person matte for clip ${clip.id}: ${what}: ${reason}`));
    else { console.warn(`Person matte for clip ${clip.id}: ${what}: ${reason}`); setFailed(true); }
  };

  useEffect(() => {
    const handle = delayRender("Loading the person matte", { timeoutInMilliseconds: 60_000 });
    loadSegmenter(isRendering).then(setSegmenter).catch((error) => fatal("the segmenter did not load", error)).finally(() => continueRender(handle));
  }, [isRendering]);

  // One decode for the matte, kept for the life of the view.
  useEffect(() => {
    if (asset.kind !== "VIDEO") return;
    const element = document.createElement("video");
    element.crossOrigin = "anonymous"; element.muted = true; element.preload = "auto"; element.playsInline = true;
    element.src = asset.src;
    video.current = element;
    return () => { element.removeAttribute("src"); element.load(); video.current = null; };
  }, [asset.kind, asset.src]);

  // Step the decode to this frame's source time (and the previous frame's when its mask is not cached) and draw the matte.
  useEffect(() => {
    const element = video.current;
    if (!segmenter || !element || !canvas.current) return;
    const speed = clip.speed || 1;
    const seconds = (n: number) => clip.sourceStartMs / 1000 + (n / fps) * speed;
    const key = (n: number) => `${clip.id}:${n}`;
    let cancelled = false;
    const handle = delayRender(`Person matte frame ${frame}`, { timeoutInMilliseconds: 30_000 });
    (async () => {
      try {
        scratch.current ??= newScratch();
        const previousKey = frame > 0 ? key(frame - 1) : null;
        let previous: { key: string; frame: CanvasImageSource } | null = null;
        if (previousKey && scratch.current.rawKey !== previousKey && isRendering) {
          // The frame before was not the last one made here (a parallel page, a seek, a retry): read it from the footage.
          // Only in an export: the editor scrubs, and a second seek per frame left the matte a frame behind the picture.
          await frameAt(element, seconds(frame - 1), fps);
          if (cancelled) return;
          previous = { key: previousKey, frame: snapshot(element) };
        } else if (previousKey && scratch.current.rawKey === previousKey) {
          previous = { key: previousKey, frame: element };
        }
        await frameAt(element, seconds(frame), fps);
        if (cancelled || !canvas.current) return;
        const fit = fitRects(element.videoWidth, element.videoHeight, width, height, clip.fit);
        const drawn = drawPersonOnly(segmenter, element, canvas.current, scratch.current, key(frame), previous, fit, width, height);
        if (!drawn) throw new Error("the segmenter returned no mask");
      } catch (error) {
        if (!cancelled) fatal(`frame ${frame} could not be matted`, error);
      } finally {
        continueRender(handle);
      }
    })();
    return () => { cancelled = true; continueRender(handle); };
  }, [segmenter, frame, fps, width, height, clip.id, clip.sourceStartMs, clip.speed, clip.fit, isRendering]);

  if (failed || asset.kind !== "VIDEO") return null;
  // The same fade, whip and motion as the footage underneath, so the person stays on their own body.
  const shown = clipPresentation(clip, frame, fps, durationInFrames, fadeOut, whipOut);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: shown.opacity, overflow: "hidden" }}>
      <AbsoluteFill style={shown.whip}>
        <canvas ref={canvas} width={width} height={height} style={{ width: "100%", height: "100%", transform: shown.transform, filter: FILTER_CSS[clip.filter] }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
