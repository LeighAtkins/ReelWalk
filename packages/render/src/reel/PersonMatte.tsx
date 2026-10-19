import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, Html5Video, continueRender, delayRender, useRemotionEnvironment, useVideoConfig } from "remotion";
import type { Clip } from "@reelwalk/core";
import { FILTER_CSS } from "./look";
import type { ReelAsset } from "./types";

/**
 * People in the shot pass in front of the type (ADR 0039). A second decode
 * of the clip runs through MediaPipe's selfie segmenter and only the person
 * pixels are drawn, above the text layer. The model and its runtime come
 * from the public MediaPipe CDN; the first frame waits for them.
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
  const { fps, width, height } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const canvas = useRef<HTMLCanvasElement>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const [segmenter, setSegmenter] = useState<Segmenter | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const handle = delayRender("Loading the person matte", { timeoutInMilliseconds: 60_000 });
    loadSegmenter(isRendering).then(setSegmenter).catch(() => setFailed(true)).finally(() => continueRender(handle));
  }, [isRendering]);
  if (failed || asset.kind !== "VIDEO") return null;
  const toFrame = (ms: number) => Math.round((ms * fps) / 1000);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <canvas ref={canvas} width={width} height={height} style={{ width: "100%", height: "100%", filter: FILTER_CSS[clip.filter] }} />
      {segmenter ? (
        <Html5Video
          src={asset.src}
          trimBefore={toFrame(clip.sourceStartMs)}
          trimAfter={toFrame(clip.sourceEndMs)}
          playbackRate={clip.speed}
          muted
          volume={0}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
          onVideoFrame={(frame) => {
            if (!canvas.current) return;
            scratch.current ??= document.createElement("canvas");
            try { drawPersonOnly(segmenter, frame, canvas.current, scratch.current); } catch { /* a dropped frame leaves the last matte */ }
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
