import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from "remotion";
import type { Clip } from "@reelwalk/core";
import { FILTER_CSS } from "./look";
import type { ReelAsset } from "./types";

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

/** Draws `frame` into `out` keeping only the pixels the segmenter calls a person. */
export function drawPersonOnly(segmenter: Segmenter, frame: CanvasImageSource, out: HTMLCanvasElement, scratch: HTMLCanvasElement) {
  const result = segmenter.segment(frame);
  const mask = result.confidenceMasks?.[0];
  const ctx = out.getContext("2d")!;
  ctx.clearRect(0, 0, out.width, out.height);
  if (!mask) { result.close(); return; }
  const data = mask.getAsFloat32Array();
  scratch.width = mask.width; scratch.height = mask.height;
  const sctx = scratch.getContext("2d")!;
  const pixels = sctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < data.length; i++) {
    // A soft threshold: confident person pixels opaque, the uncertain fringe feathered.
    pixels.data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round((data[i] - 0.35) / 0.3 * 255)));
  }
  sctx.putImageData(pixels, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(frame, 0, 0, out.width, out.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.filter = "blur(1.5px)";
  ctx.drawImage(scratch, 0, 0, out.width, out.height);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  result.close();
}

export const PersonMatteView: React.FC<{ clip: Clip; asset: ReelAsset }> = ({ clip, asset }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
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
        scratch.current ??= document.createElement("canvas");
        try { drawPersonOnly(segmenter, element, canvas.current, scratch.current); } catch { /* a dropped frame keeps the last matte */ }
      }
      finish();
    };
    const onSeeked = () => { element.removeEventListener("seeked", onSeeked); draw(); };
    if (Math.abs(element.currentTime - sourceSeconds) < 1 / (fps * 2) && element.readyState >= 2) draw();
    else {
      element.addEventListener("seeked", onSeeked);
      element.addEventListener("error", finish, { once: true });
      element.currentTime = sourceSeconds;
    }
    return () => { element.removeEventListener("seeked", onSeeked); finish(); };
  }, [segmenter, frame, fps, clip.sourceStartMs, clip.speed]);

  if (failed || asset.kind !== "VIDEO") return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <canvas ref={canvas} width={width} height={height} style={{ width: "100%", height: "100%", filter: FILTER_CSS[clip.filter] }} />
    </AbsoluteFill>
  );
};
