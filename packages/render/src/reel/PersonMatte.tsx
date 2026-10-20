import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from "remotion";
import type { Clip } from "@reelwalk/core";
import { FILTER_CSS } from "./look";
import type { ReelAsset } from "./types";
import { blend, boundingBox, grow, guidedFilter, paste, resample, toAlpha, type Mask } from "./matte-refine";

/**
 * People in the shot pass in front of the type (ADR 0039). A second decode
 * of the clip is stepped to the current frame, run through MediaPipe's
 * selfie segmenter, and only the person pixels are drawn above the text
 * layer. The decode is our own <video>, seeked per frame and segmented on
 * `seeked`, so the segmenter always gets a frame with real dimensions.
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
const WORK_WIDTH = 540, WORK_HEIGHT = 960;

export type MatteScratch = { work: HTMLCanvasElement; crop: HTMLCanvasElement; previous: Mask | null; previousKey: string | null };

function segmentToMask(segmenter: Segmenter, source: CanvasImageSource, width: number, height: number): Mask | null {
  const result = segmenter.segment(source);
  const mask = result.confidenceMasks?.[0];
  if (!mask) { result.close(); return null; }
  const copy = new Float32Array(mask.getAsFloat32Array());
  const out = resample({ data: copy, width: mask.width, height: mask.height }, width, height);
  result.close();
  return out;
}

/**
 * Draws `frame` into `out` keeping only the person. The segmenter runs on the
 * whole frame to find the person, then again on a crop around them so it sees
 * four times the detail; the soft mask is then snapped to the picture's own
 * edges (guided filter), grown a pixel so no letter bleeds into the body, and
 * eased toward the previous frame's mask (`key` names the frame; only the
 * frame right after the previous one is blended) before it is applied.
 */
export function drawPersonOnly(segmenter: Segmenter, frame: CanvasImageSource, out: HTMLCanvasElement, scratch: MatteScratch, key: string, previousKey: string | null) {
  const ctx = out.getContext("2d")!;
  ctx.clearRect(0, 0, out.width, out.height);
  scratch.work.width = WORK_WIDTH; scratch.work.height = WORK_HEIGHT;
  const wctx = scratch.work.getContext("2d", { willReadFrequently: true })!;
  wctx.drawImage(frame, 0, 0, WORK_WIDTH, WORK_HEIGHT);
  let mask = segmentToMask(segmenter, scratch.work, WORK_WIDTH, WORK_HEIGHT);
  if (!mask) return;
  // Second pass on a crop around the person, when they are small enough for it to help.
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
  // Snap the edge to the picture, grow a pixel, settle against the previous frame.
  const pixels = wctx.getImageData(0, 0, WORK_WIDTH, WORK_HEIGHT).data;
  const guide = new Float32Array(WORK_WIDTH * WORK_HEIGHT);
  for (let i = 0; i < guide.length; i++) guide[i] = (0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]) / 255;
  let refined = grow(guidedFilter(mask, guide, 5, 2e-3), 1);
  if (scratch.previous && scratch.previousKey === previousKey) refined = blend(refined, scratch.previous, 0.35);
  scratch.previous = refined; scratch.previousKey = key;
  const alpha = toAlpha(refined, 0.3, 0.6);
  const image = wctx.createImageData(WORK_WIDTH, WORK_HEIGHT);
  for (let i = 0; i < alpha.length; i++) image.data[i * 4 + 3] = alpha[i];
  wctx.putImageData(image, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(frame, 0, 0, out.width, out.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.filter = "blur(0.8px)";
  ctx.drawImage(scratch.work, 0, 0, out.width, out.height);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
}

export const PersonMatteView: React.FC<{ clip: Clip; asset: ReelAsset }> = ({ clip, asset }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const scratch = useRef<MatteScratch | null>(null);
  const [segmenter, setSegmenter] = useState<Segmenter | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const handle = delayRender("Loading the person matte", { timeoutInMilliseconds: 60_000 });
    loadSegmenter(isRendering).then(setSegmenter).catch(() => setFailed(true)).finally(() => continueRender(handle));
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

  // Step the decode to this frame's source time and segment it once it has the picture.
  useEffect(() => {
    const element = video.current;
    if (!segmenter || !element || !canvas.current) return;
    const sourceSeconds = clip.sourceStartMs / 1000 + (frame / fps) * (clip.speed || 1);
    let done = false;
    const handle = delayRender(`Person matte frame ${frame}`, { timeoutInMilliseconds: 30_000 });
    const finish = () => { if (!done) { done = true; continueRender(handle); } };
    const draw = () => {
      if (element.videoWidth > 0 && element.readyState >= 2 && canvas.current) {
        scratch.current ??= { work: document.createElement("canvas"), crop: document.createElement("canvas"), previous: null, previousKey: null };
        try { drawPersonOnly(segmenter, element, canvas.current, scratch.current, `${clip.id}:${frame}`, `${clip.id}:${frame - 1}`); } catch { /* a dropped frame keeps the last matte */ }
      }
      finish();
    };
    const onSeeked = () => { element.removeEventListener("seeked", onSeeked); draw(); };
    element.addEventListener("error", finish, { once: true });
    if (Math.abs(element.currentTime - sourceSeconds) < 1 / (fps * 2)) {
      // Already at this time (the first frame of a take, before the file has loaded): setting currentTime
      // again fires no `seeked`, so wait for the picture instead of a seek.
      if (element.readyState >= 2) draw();
      else element.addEventListener("loadeddata", draw, { once: true });
    } else {
      element.addEventListener("seeked", onSeeked);
      element.currentTime = sourceSeconds;
    }
    return () => { element.removeEventListener("seeked", onSeeked); element.removeEventListener("loadeddata", draw); element.removeEventListener("error", finish); finish(); };
  }, [segmenter, frame, fps, clip.id, clip.sourceStartMs, clip.speed]);

  if (failed || asset.kind !== "VIDEO") return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <canvas ref={canvas} width={width} height={height} style={{ width: "100%", height: "100%", filter: FILTER_CSS[clip.filter] }} />
    </AbsoluteFill>
  );
};
