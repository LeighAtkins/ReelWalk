import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from "remotion";
import { clipSourceSeconds, type Clip } from "@reelwalk/core";
import { clipFilterCss } from "./look";
import type { ReelAsset } from "./types";
import type { Mask } from "./matte-refine";
import { openVisionTask } from "./matte-assets";
import { COMPOSITE_PARAMS, MATTE_VERSION, PersonMatteRule, WORK_HEIGHT, WORK_WIDTH, type Rect, type Rgba } from "./matte-core";
import { CANCELLED, failureAction, personMatteFrame, seekTo, SerialQueue } from "./matte-decode";
import { clipPresentation, fitRects } from "./presentation";

export { WORK_HEIGHT, WORK_WIDTH } from "./matte-core";

/**
 * People in the shot pass in front of the type (ADR 0039). A second decode
 * of the clip is stepped to the current frame, run through MediaPipe's
 * selfie segmenter, and only the person pixels are drawn above the text
 * layer, through the same fit, zoom, motion and transition as the footage,
 * so the cut-out sits exactly on the body (review of 2026-10-20).
 *
 * The matte itself is `PersonMatteRule` (matte-core.ts, ADR 0051): frame n's
 * alpha is a pure function of pictures n and n − 1 of the shot and
 * MATTE_VERSION, the same in the editor and the export. This file only steps
 * the decode, hands the rule pixels and the segmenter, and draws.
 *
 * A matte that cannot load or cannot segment fails an export rather than
 * quietly leaving the words on top of the presenter; in the editor it shows
 * a warning on the preview.
 */

type ConfidenceMasks = { confidenceMasks?: { width: number; height: number; getAsFloat32Array(): Float32Array; close(): void }[]; close(): void };
type Segmenter = { segment(image: CanvasImageSource): ConfidenceMasks };
let loading: Promise<Segmenter> | null = null;

function loadSegmenter(isRendering: boolean): Promise<Segmenter> {
  loading ??= openVisionTask("selfie", isRendering, (vision, fileset, modelAssetBuffer) =>
    vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer },
      runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false,
    }) as unknown as Promise<Segmenter>,
  ).catch((error) => { loading = null; throw error; });
  return loading;
}

/** The first confidence mask of a MediaPipe result, copied out (the one per-frame allocation the matte keeps), and the result closed. */
export function takeMask(result: ConfidenceMasks): Mask | null {
  const mask = result.confidenceMasks?.[0];
  const out = mask ? { data: new Float32Array(mask.getAsFloat32Array()), width: mask.width, height: mask.height } : null;
  result.close();
  return out;
}

export type MatteScratch = { work: HTMLCanvasElement; crop: HTMLCanvasElement; alpha: ImageData | null };

export function newScratch(): MatteScratch {
  return { work: document.createElement("canvas"), crop: document.createElement("canvas"), alpha: null };
}

type Fit = ReturnType<typeof fitRects>;

/** Draws the frame into the work canvas through the clip's fit geometry (what the footage shows, at a quarter size). */
export function drawWork(frame: CanvasImageSource, scratch: MatteScratch, fit: Fit, width: number, height: number): CanvasRenderingContext2D {
  if (scratch.work.width !== WORK_WIDTH) scratch.work.width = WORK_WIDTH;
  if (scratch.work.height !== WORK_HEIGHT) scratch.work.height = WORK_HEIGHT;
  const wctx = scratch.work.getContext("2d", { willReadFrequently: true })!;
  wctx.clearRect(0, 0, WORK_WIDTH, WORK_HEIGHT);
  const kx = WORK_WIDTH / width, ky = WORK_HEIGHT / height;
  wctx.drawImage(frame, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx * kx, fit.dy * ky, fit.dw * kx, fit.dh * ky);
  return wctx;
}

/** The work canvas's pixels, for the rule's guide and the tracker. */
export function workPixels(scratch: MatteScratch): Rgba {
  const image = scratch.work.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, WORK_WIDTH, WORK_HEIGHT);
  return { data: image.data, width: image.width, height: image.height };
}

/** The selfie segmenter on the work canvas, or on a crop of it copied into the crop canvas. */
function segmentWork(segmenter: Segmenter, scratch: MatteScratch, crop: Rect | null): Mask | null {
  if (!crop) return takeMask(segmenter.segment(scratch.work));
  scratch.crop.width = crop.width; scratch.crop.height = crop.height;
  scratch.crop.getContext("2d")!.drawImage(scratch.work, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return takeMask(segmenter.segment(scratch.crop));
}

/** Draws `frame` into `out` through the clip's fit, keeping only the pixels `alpha` (0–255 at working size) keeps. */
export function compositeMatte(frame: CanvasImageSource, out: HTMLCanvasElement, scratch: MatteScratch, alpha: Uint8ClampedArray, fit: Fit) {
  const ctx = out.getContext("2d")!;
  ctx.clearRect(0, 0, out.width, out.height);
  const wctx = scratch.work.getContext("2d", { willReadFrequently: true })!;
  scratch.alpha ??= wctx.createImageData(WORK_WIDTH, WORK_HEIGHT);
  const image = scratch.alpha.data;
  for (let i = 0; i < alpha.length; i++) image[i * 4 + 3] = alpha[i];
  wctx.putImageData(scratch.alpha, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(frame, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx, fit.dy, fit.dw, fit.dh);
  ctx.globalCompositeOperation = "destination-in";
  ctx.filter = `blur(${COMPOSITE_PARAMS.blurPx}px)`;
  ctx.drawImage(scratch.work, 0, 0, out.width, out.height);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
}

/** A matte's decode and the queue its jobs run on: a replaced decoder starts with a fresh queue, never an old one's pending job. */
export type MatteDecode = { element: HTMLVideoElement; queue: SerialQueue };

/** One decode for a matte, kept for the life of the view. Unloading it fails any seek still waiting on it. */
export function useMatteDecode(asset: ReelAsset): React.RefObject<MatteDecode | null> {
  const decode = useRef<MatteDecode | null>(null);
  useEffect(() => {
    if (asset.kind !== "VIDEO") return;
    const element = document.createElement("video");
    element.crossOrigin = "anonymous"; element.muted = true; element.preload = "auto"; element.playsInline = true;
    element.src = asset.src;
    decode.current = { element, queue: new SerialQueue() };
    return () => { decode.current = null; element.removeAttribute("src"); element.load(); };
  }, [asset.kind, asset.src]);
  return decode;
}


/** A matte problem in the editor: shown on the preview, never in an export (where the render fails instead). */
export const MatteWarning: React.FC<{ text: string }> = ({ text }) => (
  <div data-testid="matte-warning" style={{ position: "absolute", left: 24, top: 24, maxWidth: "70%", padding: "10px 16px", borderRadius: 12, background: "rgba(140, 20, 20, 0.85)", color: "#fff", font: "600 28px/1.25 system-ui, sans-serif" }}>
    {text}
  </div>
);

export const PersonMatteView: React.FC<{
  clip: Clip; asset: ReelAsset; durationInFrames: number;
  /** False on frames where the layer is drawn at opacity 0 (a passing title before its crossing, ADR 0055): no seek, no segmentation. */
  active?: boolean;
  /** The reel's opening shot (ADR 0067): the same camera phase as the footage. */
  opening?: boolean;
}> = ({ clip, asset, durationInFrames, active = true, opening = false }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const canvas = useRef<HTMLCanvasElement>(null);
  const decode = useMatteDecode(asset);
  const scratch = useRef<MatteScratch | null>(null);
  const rule = useRef<PersonMatteRule | null>(null);
  const [segmenter, setSegmenter] = useState<Segmenter | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // In an export a matte that cannot be made fails the render; in the editor the words show over the person, with a warning.
  const fatal = (what: string, error: unknown) => {
    const message = `Person matte for clip ${clip.id}: ${what}: ${error instanceof Error ? error.message : String(error)}`;
    if (isRendering) cancelRender(new Error(message));
    else { console.warn(message); setWarning(message); }
  };

  // The load holds the render until the first frame's own job has taken its handle (the effect after the
  // frame effect below releases it): releasing it when the promise settled left a gap before React ran the
  // frame effect, and a still could be taken with no matte drawn (acceptance harness, frame 75).
  const loadHandle = useRef<number | null>(null);
  const releaseLoad = () => { if (loadHandle.current !== null) { continueRender(loadHandle.current); loadHandle.current = null; } };

  useEffect(() => {
    loadHandle.current = delayRender("Loading the person matte", { timeoutInMilliseconds: 60_000 });
    loadSegmenter(isRendering).then(setSegmenter).catch((error) => { fatal("the segmenter did not load", error); releaseLoad(); });
    return releaseLoad;
  }, [isRendering]);

  // Frame n's matte from pictures n and n − 1 of this shot (matte-core.ts), then the person drawn through it.
  // Jobs run one at a time on the decode's queue; a superseded job's seek is aborted, so it never blocks the next.
  useEffect(() => {
    const current = decode.current;
    // An idle frame is not matted at all; the first active frame reads its previous picture itself (matte-core's rule).
    if (!active || !segmenter || !current || !canvas.current || warning) return;
    const { element, queue } = current;
    const seconds = (n: number) => clipSourceSeconds(clip, n, fps, durationInFrames);
    const controller = new AbortController();
    let cancelled = false;
    const handle = delayRender(`Person matte frame ${frame}`, { timeoutInMilliseconds: 30_000 });
    const job = async () => {
      try {
        if (cancelled || decode.current !== current) throw CANCELLED;
        const s = (scratch.current ??= newScratch());
        const r = (rule.current ??= new PersonMatteRule());
        const fitNow = () => fitRects(element.videoWidth, element.videoHeight, width, height, clip.fit);
        const alpha = await personMatteFrame({
          rule: r, frame, seconds,
          // A key names a picture: the same exact source time through the same fit is the same raw mask.
          scope: `${asset.src}|${clip.fit}|${width}x${height}`,
          seek: async (t) => { await seekTo(element, t, { signal: controller.signal }); if (cancelled) throw CANCELLED; },
          capture: () => { drawWork(element, s, fitNow(), width, height); return { pixels: workPixels(s), segment: (crop) => segmentWork(segmenter, s, crop) }; },
        });
        if (!alpha) throw new Error("the segmenter returned no mask");
        if (cancelled || !canvas.current) return;
        compositeMatte(element, canvas.current, s, alpha, fitNow());
      } catch (error) {
        const action = cancelled ? "ignore" : failureAction(error, isRendering);
        if (action === "fail") fatal(`frame ${frame} could not be matted`, error);
        // A slow seek in the editor: this frame shows no matte, the next one tries again.
        else if (action === "retry") console.warn(`Person matte for clip ${clip.id}: frame ${frame}: ${error instanceof Error ? error.message : String(error)}; retrying on the next frame`);
      } finally {
        continueRender(handle);
      }
    };
    void queue.run(job);
    return () => { cancelled = true; controller.abort(); continueRender(handle); };
  }, [active, segmenter, frame, fps, width, height, asset.src, clip.id, clip.sourceStartMs, clip.speed, clip.fit, warning]);

  // Declared after the frame effect, so on the render where the segmenter arrives that effect has already
  // taken the frame's handle when this lets the load's go.
  useEffect(() => { if (segmenter || warning) releaseLoad(); }, [segmenter, warning]);

  if (asset.kind !== "VIDEO") return null;
  if (warning) return isRendering ? null : <AbsoluteFill style={{ pointerEvents: "none" }}><MatteWarning text={warning} /></AbsoluteFill>;
  // The same motion and ramp blur as the footage underneath, so the person stays on their own body (a transition's
  // slide or crossfade is the composition's AtCuts around this layer, ADR 0083).
  const shown = clipPresentation(clip, frame, fps, durationInFrames, opening);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: shown.opacity, overflow: "hidden" }}>
      <AbsoluteFill style={shown.blur}>
        <canvas ref={canvas} width={width} height={height} data-matte-version={MATTE_VERSION} style={{ width: "100%", height: "100%", transform: shown.transform, filter: clipFilterCss(clip) }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
