import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from "remotion";
import { applyHomography, homography, pinnedProgress, textQuadAt, type Clip, type TextOverlay, type Timeline } from "@reelwalk/core";
import { FILTER_CSS } from "./look";
import type { ReelAsset } from "./types";
import { luminance, Workspace } from "./matte-refine";
import { openVisionTask } from "./matte-assets";
import { describeTaps, MATTE_VERSION, objectAlpha, objectRaw, trackTaps, WORK_HEIGHT, WORK_WIDTH } from "./matte-core";
import type { Gray } from "./point-track";
import { clipPresentation, fitRects } from "./presentation";
import { CANCELLED, compositeMatte, drawWork, frameAt, MatteWarning, newScratch, takeMask, useMatteDecode, workPixels, type MatteScratch } from "./PersonMatte";

/**
 * Things in front of a title, chosen with a tap (ADR 0044). The author taps
 * the plant, the chair back, the railing; MediaPipe's interactive segmenter
 * ("magic touch") returns the object under that point, and only its pixels
 * are drawn above the text layer, so the words go behind it.
 *
 * The tap is stored on the pin's first frame. On each frame it is found again
 * by a point tracker on the footage (ADR 0051), searching around where the
 * title's wall homography would carry it, so a plant that moves with
 * parallax is still the thing asked about; when the tracker loses it the
 * homography's point is used and the canvas's `data-matte-status` says so.
 * Deterministic: each frame's mask depends on that frame, the pin frame and
 * the taps alone.
 *
 * A tap in the picture that the segmenter gives no mask for fails an export
 * (the author asked for that object to be in front); in the editor the
 * preview shows a warning. Taps that have all left the frame give an empty
 * matte, which is right.
 */

type TouchSegmenter = { segment(image: CanvasImageSource, roi: { keypoint: { x: number; y: number } }): Parameters<typeof takeMask>[0] };
let loading: Promise<TouchSegmenter> | null = null;

function loadTouch(isRendering: boolean): Promise<TouchSegmenter> {
  loading ??= openVisionTask("touch", isRendering, (vision, fileset, modelAssetBuffer) =>
    vision.InteractiveSegmenterLegacy.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer },
      outputConfidenceMasks: true, outputCategoryMask: false,
    }) as unknown as Promise<TouchSegmenter>,
  ).catch((error) => { loading = null; throw error; });
  return loading;
}

/** Where a first-frame point is on this frame by the title's tracked plane, when it has one: the tracker's prior and its fallback. */
export function carriedTaps(text: TextOverlay, timeline: Timeline, reelMs: number): { x: number; y: number }[] {
  const taps = text.occluders ?? [];
  if (!text.pin?.quad) return taps;
  const quad = textQuadAt(text, pinnedProgress(timeline, text, reelMs));
  if (!quad) return taps;
  const H = homography(text.pin.quad as [number, number, number, number, number, number, number, number], quad as [number, number, number, number, number, number, number, number]);
  if (!H) return taps;
  return taps.map((tap) => { const [x, y] = applyHomography(H, tap.x, tap.y); return { x, y }; });
}

type Buffers = { ws: Workspace; raw: Float32Array; alpha: Uint8ClampedArray; cur: Gray; ref: { key: string; gray: Gray } | null };

function newBuffers(): Buffers {
  const n = WORK_WIDTH * WORK_HEIGHT;
  return { ws: new Workspace(), raw: new Float32Array(n), alpha: new Uint8ClampedArray(n), cur: { data: new Float32Array(n), width: WORK_WIDTH, height: WORK_HEIGHT }, ref: null };
}

export const ObjectMatteView: React.FC<{ clip: Clip; asset: ReelAsset; text: TextOverlay; timeline: Timeline; from: number; durationInFrames: number; fadeOut?: boolean; whipOut?: Clip["whipDirection"] | null }> = ({ clip, asset, text, timeline, from, durationInFrames, fadeOut = false, whipOut = null }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useMatteDecode(asset);
  const scratch = useRef<MatteScratch | null>(null);
  const buffers = useRef<Buffers | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lastStatus = useRef("");
  const [segmenter, setSegmenter] = useState<TouchSegmenter | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const refTaps = text.occluders ?? [];
  const priors = carriedTaps(text, timeline, ((from + frame) * 1000) / fps);
  const tapKey = [...refTaps, ...priors].map((tap) => `${tap.x.toFixed(4)},${tap.y.toFixed(4)}`).join(";");
  // The pin's first frame, where the taps were made: the tracker's reference, when it is this clip's footage.
  const pinMs = text.pin && text.pin.assetId === clip.assetId && text.pin.quad ? text.pin.fromMs : null;

  const fatal = (what: string, error: unknown) => {
    const message = `Object matte for "${text.text.slice(0, 20)}" on clip ${clip.id}: ${what}: ${error instanceof Error ? error.message : String(error)}`;
    if (isRendering) cancelRender(new Error(message));
    else { console.warn(message); setWarning(message); }
  };

  useEffect(() => {
    const handle = delayRender("Loading the object matte", { timeoutInMilliseconds: 60_000 });
    loadTouch(isRendering).then(setSegmenter).catch((error) => fatal("the segmenter did not load", error)).finally(() => continueRender(handle));
  }, [isRendering]);

  useEffect(() => {
    const element = video.current;
    if (!segmenter || !element || !canvas.current || warning || !refTaps.length) return;
    const seconds = clip.sourceStartMs / 1000 + (frame / fps) * (clip.speed || 1);
    let cancelled = false;
    const handle = delayRender(`Object matte frame ${frame}`, { timeoutInMilliseconds: 30_000 });
    const job = async () => {
      if (cancelled) return;
      try {
        const s = (scratch.current ??= newScratch());
        const b = (buffers.current ??= newBuffers());
        const fitNow = () => fitRects(element.videoWidth, element.videoHeight, width, height, clip.fit);
        // The reference picture, once per view: the pin frame through the same fit.
        const refKey = pinMs === null ? null : `${asset.src}|${clip.fit}|${width}x${height}|${pinMs}`;
        if (refKey && b.ref?.key !== refKey) {
          await frameAt(element, pinMs! / 1000, fps);
          if (cancelled) throw CANCELLED;
          drawWork(element, s, fitNow(), width, height);
          const gray = { data: luminance(workPixels(s).data, new Float32Array(WORK_WIDTH * WORK_HEIGHT)), width: WORK_WIDTH, height: WORK_HEIGHT };
          b.ref = { key: refKey, gray };
        }
        await frameAt(element, seconds, fps);
        if (cancelled || !canvas.current) return;
        const fit = fitNow();
        drawWork(element, s, fit, width, height);
        const pixels = workPixels(s);
        const placed = refKey ? trackTaps(b.ref!.gray, refTaps, { ...b.cur, data: luminance(pixels.data, b.cur.data) }, priors) : trackTaps(null, refTaps, null, priors);
        const outcome = objectRaw(pixels, (point) => takeMask(segmenter.segment(s.work, { keypoint: point })), placed.taps, b.ws, b.raw);
        const status = `${outcome}; ${describeTaps(placed.status)}`;
        canvas.current.dataset.matteStatus = status;
        if (status !== lastStatus.current && placed.status.some((st) => st !== "tracked" && st !== "static")) console.info(`Object matte for "${text.text.slice(0, 20)}" frame ${frame}: ${status}`);
        lastStatus.current = status;
        if (outcome === "no-mask") throw new Error("the segmenter returned no mask for a tapped object in the picture");
        if (outcome === "off-frame") { canvas.current.getContext("2d")?.clearRect(0, 0, width, height); return; }
        compositeMatte(element, canvas.current, s, objectAlpha(b.raw, b.alpha), fit);
      } catch (error) {
        if (!cancelled && error !== CANCELLED) fatal(`frame ${frame} could not be matted`, error);
      } finally {
        continueRender(handle);
      }
    };
    queue.current = queue.current.then(job);
    return () => { cancelled = true; continueRender(handle); };
  }, [segmenter, frame, fps, width, height, asset.src, clip.id, clip.sourceStartMs, clip.speed, clip.fit, tapKey, pinMs, warning]);

  if (asset.kind !== "VIDEO" || !refTaps.length) return null;
  if (warning) return isRendering ? null : <AbsoluteFill style={{ pointerEvents: "none" }}><MatteWarning text={warning} /></AbsoluteFill>;
  const shown = clipPresentation(clip, frame, fps, durationInFrames, fadeOut, whipOut);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: shown.opacity, overflow: "hidden" }}>
      <AbsoluteFill style={shown.whip}>
        <canvas ref={canvas} width={width} height={height} data-matte-version={MATTE_VERSION} style={{ width: "100%", height: "100%", transform: shown.transform, filter: FILTER_CSS[clip.filter] }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
