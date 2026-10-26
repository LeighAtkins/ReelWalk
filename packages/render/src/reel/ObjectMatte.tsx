import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from "remotion";
import { applyHomography, clipSourceSeconds, homography, pinnedProgress, tapReference, textQuadAt, type Clip, type TextOverlay, type Timeline } from "@reelwalk/core";
import { clipFilterCss } from "./look";
import type { ReelAsset } from "./types";
import { luminance, Workspace } from "./matte-refine";
import { openVisionTask } from "./matte-assets";
import { describeTaps, MATTE_VERSION, objectAlpha, objectRaw, titleActive, trackTaps, WORK_HEIGHT, WORK_WIDTH, type TapReference } from "./matte-core";
import { CANCELLED, failureAction, seekTo } from "./matte-decode";
import type { Gray } from "./point-track";
import { clipPresentation, fitRects } from "./presentation";
import { compositeMatte, drawWork, MatteWarning, newScratch, takeMask, useMatteDecode, workPixels, type MatteScratch } from "./PersonMatte";

/**
 * Things in front of a title, chosen with a tap (ADR 0044). The author taps
 * the plant, the chair back, the railing; MediaPipe's interactive segmenter
 * ("magic touch") returns the object under that point, and only its pixels
 * are drawn above the text layer, so the words go behind it.
 *
 * A tap is stored in the pin's first-frame coordinates and, since ADR 0051,
 * with the source time of the frame it was made on (`atMs`). On each frame
 * a point tracker finds it again from that frame, searching around where the
 * title's wall homography would carry it, so a plant that moves with
 * parallax is still the thing asked about. Older taps (no `atMs`), and taps
 * the tracker loses, ride the wall's homography; the canvas's
 * `data-matte-status` says which. Deterministic: each frame's mask depends on
 * that frame, the taps' own frames and the taps alone.
 *
 * Only while the title is on screen: then a tap in the picture that the
 * segmenter gives no mask for fails an export (the author asked for that
 * object to be in front), and in the editor shows a warning. Taps that have
 * all left the frame give an empty matte, which is right.
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

type Buffers = { ws: Workspace; raw: Float32Array; alpha: Uint8ClampedArray; cur: Gray; /** Tap frames' luminance, by picture key. */ refs: Map<string, Gray> };

function newBuffers(): Buffers {
  const n = WORK_WIDTH * WORK_HEIGHT;
  return { ws: new Workspace(), raw: new Float32Array(n), alpha: new Uint8ClampedArray(n), cur: { data: new Float32Array(n), width: WORK_WIDTH, height: WORK_HEIGHT }, refs: new Map() };
}

export const ObjectMatteView: React.FC<{ clip: Clip; asset: ReelAsset; text: TextOverlay; timeline: Timeline; from: number; durationInFrames: number; /** The reel's opening shot (ADR 0067). */ opening?: boolean }> = ({ clip, asset, text, timeline, from, durationInFrames, opening = false }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const canvas = useRef<HTMLCanvasElement>(null);
  const decode = useMatteDecode(asset);
  const scratch = useRef<MatteScratch | null>(null);
  const buffers = useRef<Buffers | null>(null);
  const lastStatus = useRef("");
  const [segmenter, setSegmenter] = useState<TouchSegmenter | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const refTaps = text.occluders ?? [];
  const priors = carriedTaps(text, timeline, ((from + frame) * 1000) / fps);
  // Each tap's own frame and point, when it was recorded and the title is pinned to this clip's footage.
  const references = refTaps.map((tap) => (text.pin?.assetId === clip.assetId ? tapReference(text, tap) : null));
  const active = titleActive(text, from + frame, fps);
  const tapKey = [
    ...priors.map((tap) => `${tap.x.toFixed(4)},${tap.y.toFixed(4)}`),
    ...references.map((ref) => (ref ? `${ref.x.toFixed(4)},${ref.y.toFixed(4)}@${ref.sourceMs}` : "-")),
  ].join(";");

  const fatal = (what: string, error: unknown) => {
    const message = `Object matte for "${text.text.slice(0, 20)}" on clip ${clip.id}: ${what}: ${error instanceof Error ? error.message : String(error)}`;
    if (isRendering) cancelRender(new Error(message));
    else { console.warn(message); setWarning(message); }
  };

  // The load holds the render until the first frame's own job has taken its handle (the effect after the
  // frame effect below releases it): releasing it when the promise settled left a gap before React ran the
  // frame effect, and a still could be taken with no matte drawn (acceptance harness, frame 75).
  const loadHandle = useRef<number | null>(null);
  const releaseLoad = () => { if (loadHandle.current !== null) { continueRender(loadHandle.current); loadHandle.current = null; } };

  useEffect(() => {
    loadHandle.current = delayRender("Loading the object matte", { timeoutInMilliseconds: 60_000 });
    loadTouch(isRendering).then(setSegmenter).catch((error) => { fatal("the segmenter did not load", error); releaseLoad(); });
    return releaseLoad;
  }, [isRendering]);

  useEffect(() => {
    const current = decode.current;
    if (!segmenter || !current || !canvas.current || warning || !refTaps.length) return;
    // Off screen the title needs no matte, and an object the segmenter cannot find there is no error.
    if (!active) { canvas.current.getContext("2d")?.clearRect(0, 0, width, height); canvas.current.dataset.matteStatus = "inactive"; return; }
    const { element, queue } = current;
    const seconds = clipSourceSeconds(clip, frame, fps, durationInFrames);
    const controller = new AbortController();
    let cancelled = false;
    const handle = delayRender(`Object matte frame ${frame}`, { timeoutInMilliseconds: 30_000 });
    const seek = async (t: number) => { await seekTo(element, t, { signal: controller.signal }); if (cancelled) throw CANCELLED; };
    const job = async () => {
      try {
        if (cancelled || decode.current !== current) throw CANCELLED;
        const s = (scratch.current ??= newScratch());
        const b = (buffers.current ??= newBuffers());
        const fitNow = () => fitRects(element.videoWidth, element.videoHeight, width, height, clip.fit);
        const scope = `${asset.src}|${clip.fit}|${width}x${height}`;
        // Each tap's own frame, once per view: its picture through the same fit, as luminance.
        const refs: (TapReference | null)[] = [];
        for (const reference of references) {
          if (!reference) { refs.push(null); continue; }
          const key = `${scope}|${reference.sourceMs}`;
          let gray = b.refs.get(key);
          if (!gray) {
            await seek(reference.sourceMs / 1000);
            drawWork(element, s, fitNow(), width, height);
            gray = { data: luminance(workPixels(s).data, new Float32Array(WORK_WIDTH * WORK_HEIGHT)), width: WORK_WIDTH, height: WORK_HEIGHT };
            b.refs.set(key, gray);
          }
          refs.push({ gray, point: reference });
        }
        await seek(seconds);
        if (!canvas.current) return;
        const fit = fitNow();
        drawWork(element, s, fit, width, height);
        const pixels = workPixels(s);
        const placed = trackTaps(refs, refs.some(Boolean) ? { ...b.cur, data: luminance(pixels.data, b.cur.data) } : null, priors);
        const outcome = objectRaw(pixels, (point) => takeMask(segmenter.segment(s.work, { keypoint: point })), placed.taps, b.ws, b.raw);
        const status = `${outcome}; ${describeTaps(placed.status)}`;
        canvas.current.dataset.matteStatus = status;
        if (status !== lastStatus.current && placed.status.some((st) => st !== "tracked" && st !== "wall")) console.info(`Object matte for "${text.text.slice(0, 20)}" frame ${frame}: ${status}`);
        lastStatus.current = status;
        if (outcome === "no-mask") throw new Error("the segmenter returned no mask for a tapped object in the picture");
        if (outcome === "off-frame") { canvas.current.getContext("2d")?.clearRect(0, 0, width, height); return; }
        compositeMatte(element, canvas.current, s, objectAlpha(b.raw, b.alpha), fit);
      } catch (error) {
        const action = cancelled ? "ignore" : failureAction(error, isRendering);
        if (action === "fail") fatal(`frame ${frame} could not be matted`, error);
        // A slow seek in the editor: this frame shows no matte, the next one tries again.
        else if (action === "retry") console.warn(`Object matte for "${text.text.slice(0, 20)}" frame ${frame}: ${error instanceof Error ? error.message : String(error)}; retrying on the next frame`);
      } finally {
        continueRender(handle);
      }
    };
    void queue.run(job);
    return () => { cancelled = true; controller.abort(); continueRender(handle); };
  }, [segmenter, frame, fps, width, height, asset.src, clip.id, clip.sourceStartMs, clip.speed, clip.fit, tapKey, active, warning]);

  // Declared after the frame effect, so on the render where the segmenter arrives that effect has already
  // taken the frame's handle when this lets the load's go.
  useEffect(() => { if (segmenter || warning) releaseLoad(); }, [segmenter, warning]);

  if (asset.kind !== "VIDEO" || !refTaps.length) return null;
  if (warning) return isRendering ? null : <AbsoluteFill style={{ pointerEvents: "none" }}><MatteWarning text={warning} /></AbsoluteFill>;
  const shown = clipPresentation(clip, frame, fps, durationInFrames, opening);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: shown.opacity, overflow: "hidden" }}>
      <AbsoluteFill>
        <canvas ref={canvas} width={width} height={height} data-matte-version={MATTE_VERSION} style={{ width: "100%", height: "100%", transform: shown.transform, filter: clipFilterCss(clip) }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
