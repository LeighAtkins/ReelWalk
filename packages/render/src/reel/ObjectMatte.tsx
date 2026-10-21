import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from "remotion";
import { applyHomography, homography, pinnedProgress, textQuadAt, type Clip, type TextOverlay, type Timeline } from "@reelwalk/core";
import { FILTER_CSS } from "./look";
import type { ReelAsset } from "./types";
import { grow, guidedFilter, resample, type Mask } from "./matte-refine";
import { openVisionTask } from "./matte-assets";
import { clipPresentation, fitRects } from "./presentation";
import { compositePerson, drawWork, frameAt, newScratch, WORK_HEIGHT, WORK_WIDTH, type MatteScratch } from "./PersonMatte";

/**
 * Things in front of a title, chosen with a tap (ADR 0044). The author taps
 * the plant, the chair back, the railing; MediaPipe's interactive segmenter
 * ("magic touch") returns the object under that point, and only its pixels
 * are drawn above the text layer, so the words go behind it. The tap is
 * stored in the first frame's coordinates and carried through the shot by
 * the title's tracked plane, so the same object is asked for on every frame.
 * Deterministic: each frame's mask depends on that frame and the tap alone.
 */

type TouchSegmenter = { segment(image: CanvasImageSource, roi: { keypoint: { x: number; y: number } }): { confidenceMasks?: { width: number; height: number; getAsFloat32Array(): Float32Array; close(): void }[]; close(): void } };
let loading: Promise<TouchSegmenter> | null = null;

function loadTouch(isRendering: boolean): Promise<TouchSegmenter> {
  // Pinned runtime and hash-checked model bytes (ADR 0051).
  loading ??= openVisionTask("touch", isRendering, (vision, fileset, modelAssetBuffer) =>
    vision.InteractiveSegmenterLegacy.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer },
      outputConfidenceMasks: true, outputCategoryMask: false,
    }) as unknown as Promise<TouchSegmenter>,
  ).catch((error) => { loading = null; throw error; });
  return loading;
}

/** The object under each tap, as one soft mask at working size: the union of the segmenter's answers, snapped to the picture's edges and grown a little. Pure in the frame and the taps. */
export function objectMask(segmenter: TouchSegmenter, frame: CanvasImageSource, scratch: MatteScratch, fit: ReturnType<typeof fitRects>, width: number, height: number, taps: { x: number; y: number }[]): Mask | null {
  const wctx = drawWork(frame, scratch, fit, width, height);
  let union: Mask | null = null;
  for (const tap of taps) {
    if (tap.x < 0 || tap.x > 1 || tap.y < 0 || tap.y > 1) continue;
    const result = segmenter.segment(scratch.work, { keypoint: { x: tap.x, y: tap.y } });
    const mask = result.confidenceMasks?.[0];
    if (!mask) { result.close(); continue; }
    const copy = new Float32Array(mask.getAsFloat32Array());
    const sized = resample({ data: copy, width: mask.width, height: mask.height }, WORK_WIDTH, WORK_HEIGHT);
    result.close();
    if (!union) union = sized;
    else for (let i = 0; i < union.data.length; i++) union.data[i] = Math.max(union.data[i], sized.data[i]);
  }
  if (!union) return null;
  const pixels = wctx.getImageData(0, 0, WORK_WIDTH, WORK_HEIGHT).data;
  const guide = new Float32Array(WORK_WIDTH * WORK_HEIGHT);
  for (let i = 0; i < guide.length; i++) guide[i] = (0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]) / 255;
  return grow(guidedFilter(union, guide, 5, 2e-3), 2);
}

/** Where a first-frame point is on this frame: carried by the title's tracked plane when it has one. */
export function carriedTaps(text: TextOverlay, timeline: Timeline, reelMs: number): { x: number; y: number }[] {
  const taps = text.occluders ?? [];
  if (!text.pin?.quad) return taps;
  const quad = textQuadAt(text, pinnedProgress(timeline, text, reelMs));
  if (!quad) return taps;
  const H = homography(text.pin.quad as [number, number, number, number, number, number, number, number], quad as [number, number, number, number, number, number, number, number]);
  if (!H) return taps;
  return taps.map((tap) => { const [x, y] = applyHomography(H, tap.x, tap.y); return { x, y }; });
}

export const ObjectMatteView: React.FC<{ clip: Clip; asset: ReelAsset; text: TextOverlay; timeline: Timeline; from: number; durationInFrames: number; fadeOut?: boolean; whipOut?: Clip["whipDirection"] | null }> = ({ clip, asset, text, timeline, from, durationInFrames, fadeOut = false, whipOut = null }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const scratch = useRef<MatteScratch | null>(null);
  const [segmenter, setSegmenter] = useState<TouchSegmenter | null>(null);
  const [failed, setFailed] = useState(false);
  const taps = carriedTaps(text, timeline, ((from + frame) * 1000) / fps);
  const tapKey = taps.map((tap) => `${tap.x.toFixed(4)},${tap.y.toFixed(4)}`).join(";");

  const fatal = (what: string, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    if (isRendering) cancelRender(new Error(`Object matte for "${text.text.slice(0, 20)}" on clip ${clip.id}: ${what}: ${reason}`));
    else { console.warn(`Object matte for "${text.text.slice(0, 20)}" on clip ${clip.id}: ${what}: ${reason}`); setFailed(true); }
  };

  useEffect(() => {
    const handle = delayRender("Loading the object matte", { timeoutInMilliseconds: 60_000 });
    loadTouch(isRendering).then(setSegmenter).catch((error) => fatal("the segmenter did not load", error)).finally(() => continueRender(handle));
  }, [isRendering]);

  useEffect(() => {
    if (asset.kind !== "VIDEO") return;
    const element = document.createElement("video");
    element.crossOrigin = "anonymous"; element.muted = true; element.preload = "auto"; element.playsInline = true;
    element.src = asset.src;
    video.current = element;
    return () => { element.removeAttribute("src"); element.load(); video.current = null; };
  }, [asset.kind, asset.src]);

  useEffect(() => {
    const element = video.current;
    if (!segmenter || !element || !canvas.current) return;
    const seconds = clip.sourceStartMs / 1000 + (frame / fps) * (clip.speed || 1);
    let cancelled = false;
    const handle = delayRender(`Object matte frame ${frame}`, { timeoutInMilliseconds: 30_000 });
    (async () => {
      try {
        scratch.current ??= newScratch();
        await frameAt(element, seconds, fps);
        if (cancelled || !canvas.current) return;
        const fit = fitRects(element.videoWidth, element.videoHeight, width, height, clip.fit);
        const mask = objectMask(segmenter, element, scratch.current, fit, width, height, taps);
        if (!mask) { canvas.current.getContext("2d")?.clearRect(0, 0, width, height); return; }
        compositePerson(element, canvas.current, scratch.current, mask, fit);
      } catch (error) {
        if (!cancelled) fatal(`frame ${frame} could not be matted`, error);
      } finally {
        continueRender(handle);
      }
    })();
    return () => { cancelled = true; continueRender(handle); };
  }, [segmenter, frame, fps, width, height, clip.id, clip.sourceStartMs, clip.speed, clip.fit, tapKey]);

  if (failed || asset.kind !== "VIDEO" || !taps.length) return null;
  const shown = clipPresentation(clip, frame, fps, durationInFrames, fadeOut, whipOut);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: shown.opacity, overflow: "hidden" }}>
      <AbsoluteFill style={shown.whip}>
        <canvas ref={canvas} width={width} height={height} style={{ width: "100%", height: "100%", transform: shown.transform, filter: FILTER_CSS[clip.filter] }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
