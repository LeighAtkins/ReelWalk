"use client";

import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { clipPicture, onScreenAt, REEL_FORMAT, type ClipPicture, type Timeline, type ViewportRect, type XY } from "@reelwalk/core";
import type { ReelAsset } from "@reelwalk/render/reel";
import { inspectSource } from "@/app/inspect-actions";
import { loadImage, loadVideo, releaseVideo, seekVideo } from "./frame-service";
import { SourceReader } from "./source-reader";
import { useClock, type Clock } from "./clock";
import {
  doubleTapView, drawSourceView, faceView, INITIAL_INSPECT, inspectFileName, inspectReducer, panBy, pinchView, smoothAt, stepFrameMs,
  viewMatrix, visibleSourceRect, wheelView, zoomAbout, zoomCap, zoomLabel, type FaceHint, type InspectAction, type InspectView, type StageSize,
} from "./inspect-view";

/** What Inspect knows about an asset beyond what the Player plays (the original's URL is asked for when Footage only opens). */
export type InspectSource = {
  width: number | null;
  height: number | null;
  /** An AI-generated take: the Face chip is offered on it. */
  ai: boolean;
  face: FaceHint | null;
};

type Props = {
  clock: Clock;
  timeline: Timeline;
  assets: Record<string, ReelAsset>;
  sources: Record<string, InspectSource>;
  /** The stage frame: the Player inside it is magnified for Final. */
  frame: RefObject<HTMLDivElement | null>;
  /** The composition's rectangle inside the stage frame (ADR 0047). */
  plane: ViewportRect | null;
  /** Where the control bars go: the full-screen stage, outside the frame. */
  host: HTMLElement | null;
  totalMs: number;
  onSeek(ms: number): void;
  onClose(): void;
};

type Media = HTMLVideoElement | HTMLImageElement;
/** The frame on screen in Footage only: the reader's own element, at that frame, drawn from directly (no copy). */
type SourceFrame = { key: string; media: Media; width: number; height: number; picture: ClipPicture; src: string; original: boolean; seekMs: number; reelMs: number };
/** An asset's original for Footage only: asked for, a presigned URL (with when it was signed), or unavailable (the preview is used). */
type Original = { state: "pending" } | { state: "ready"; url: string; at: number } | { state: "failed" };
/** The presigned URL lasts 15 minutes; one older than this is asked for again rather than given up on. */
const ORIGINAL_FRESH_MS = 10 * 60_000;

/** Caps the canvas's backing store: a 412 px phone at 3× is 1236 px wide, enough for every source pixel at 8×. */
const MAX_DPR = 3;
/** A tap moves less than this (px) and a double-tap's taps land within 300 ms and 30 px. */
const TAP_SLOP = 8, DOUBLE_TAP_MS = 300, DOUBLE_TAP_PX = 30;

/**
 * Inspect mode (ADR 0057): the frame full screen, magnified 1×–8× with
 * pinch, drag, wheel and double-tap; Final (the Player, titles and mattes
 * included) or Footage only (the clip's source frame at its own resolution,
 * placed where the composition puts it); frame steps that keep the zoom.
 */
export function InspectMode({ clock, timeline, assets, sources, frame, plane, host, totalMs, onSeek, onClose }: Props) {
  const [state, send] = useReducer(inspectReducer, INITIAL_INSPECT);
  const { view, layer } = state;
  const layerRef = useRef(layer);
  useEffect(() => { layerRef.current = layer; }, [layer]);
  // Every view and layer change is held to the layer's zoom cap on this screen (Final stops at 4x on a 3x phone).
  const capFor = (forLayer: typeof layer) => zoomCap(forLayer, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  const dispatch = (action: InspectAction) =>
    send(action.type === "view" ? { ...action, max: capFor(layerRef.current) } : action.type === "layer" ? { ...action, max: capFor(action.layer) } : action);
  const now = useClock(clock);
  const at = onScreenAt(timeline, now);
  const smooth = smoothAt(view.zoom, state.smoothing);
  const stage: StageSize | null = plane && plane.width > 0 ? { width: plane.width, height: plane.height } : null;
  const surface = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [note, setNote] = useState<string | null>(null);

  // ── Final: the Player itself, magnified. Text is re-rasterised at the zoom; video and canvases are their own pixels.
  useEffect(() => {
    const player = frame.current?.querySelector<HTMLElement>(".player");
    if (!player || !plane) return;
    player.style.transformOrigin = `${plane.left}px ${plane.top}px`;
    player.style.transform = `matrix(${viewMatrix(view, plane.width, plane.height).join(",")})`;
    player.style.imageRendering = smooth ? "" : "pixelated";
  }, [frame, plane, view, smooth]);
  useEffect(() => () => {
    const player = frame.current?.querySelector<HTMLElement>(".player");
    if (player) { player.style.transform = ""; player.style.transformOrigin = ""; player.style.imageRendering = ""; }
  }, [frame]);

  // ── Footage only: the clip's source at its own resolution, read by Inspect's own element and drawn from it directly.
  const reader = useMemo(() => new SourceReader<Media>({
    open: (src, kind) => (kind === "IMAGE" ? loadImage(src) : loadVideo(src, "The original")),
    seek: (media, ms) => (media instanceof HTMLVideoElement ? seekVideo(media, ms) : Promise.resolve()),
    free: (media) => { if (media instanceof HTMLVideoElement) releaseVideo(media); },
  }), []);
  const [originals, setOriginals] = useState<Record<string, Original>>({});
  const clipId = at?.clip.id ?? null, mediaMs = at ? Number(at.mediaMs.toFixed(2)) : null;
  const assetId = at?.clip.assetId ?? null;
  const info = assetId ? sources[assetId] : undefined;
  const kind = assetId ? assets[assetId]?.kind ?? null : null;
  const wantSource = layer === "footage";
  // The original's URL is asked for when Footage only first needs it: short-lived, presigned, for this studio only.
  const original = assetId ? originals[assetId] : undefined;
  useEffect(() => {
    if (!wantSource || !assetId || original) return;
    setOriginals((all) => ({ ...all, [assetId]: { state: "pending" } }));
    inspectSource({ assetId })
      .then((result) => setOriginals((all) => ({ ...all, [assetId]: result ? { state: "ready", url: result.url, at: Date.now() } : { state: "failed" } })))
      .catch(() => setOriginals((all) => ({ ...all, [assetId]: { state: "failed" } })));
  }, [wantSource, assetId, original]);
  const src = !assetId || !original || original.state === "pending" ? null : original.state === "ready" ? original.url : assets[assetId]?.src ?? null;
  const key = `${clipId}|${mediaMs}|${src}`;
  const [loaded, setLoaded] = useState<SourceFrame | null>(null);
  useEffect(() => {
    if (!wantSource || !clipId || mediaMs === null || !src || !kind || !assetId) return;
    let live = true;
    const reelMs = now, signed = original?.state === "ready" && original.url === src ? original : null;
    reader.read(src, kind, mediaMs).then((result) => {
      if (!live || result.status === "superseded") return;
      if (result.status === "failed") {
        if (signed) {
          // A link past its life is asked for again; one that never worked gives way to the preview.
          setOriginals((all) => {
            const next = { ...all };
            if (Date.now() - signed.at > ORIGINAL_FRESH_MS) delete next[assetId]; else next[assetId] = { state: "failed" };
            return next;
          });
        } else setNote(kind === "IMAGE" && timeline.clips.find((c) => c.id === clipId)?.pano ? "A 360 photo has no flat frame to inspect; Final shows it." : "This frame could not be read.");
        return;
      }
      const moment = onScreenAt(timeline, reelMs);
      if (!moment) return;
      setNote(null);
      setLoaded({ key, media: result.media, width: result.width, height: result.height, picture: clipPicture(moment.clip, { width: result.width, height: result.height }, moment.moment), src, original: Boolean(signed), seekMs: result.seekMs, reelMs });
    });
    return () => { live = false; };
    // `now` labels the frame; the read itself depends on the clip, the media time and the file.
  }, [wantSource, clipId, mediaMs, src, kind, assetId, key, reader, timeline]);

  // Leaving Inspect frees the original's element and the canvas at once (iOS caps canvas memory and frees it lazily).
  useEffect(() => () => {
    reader.release();
    const out = canvas.current;
    if (out) { out.width = 0; out.height = 0; }
  }, [reader]);

  // Draws the last frame that arrived, so stepping never flashes black; its own attributes say which it is.
  useEffect(() => {
    const out = canvas.current;
    if (!out || !stage || !wantSource) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const w = Math.round(stage.width * dpr), h = Math.round(stage.height * dpr);
    if (out.width !== w) out.width = w;
    if (out.height !== h) out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    if (!loaded) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); return; }
    drawSourceView(ctx, loaded.media, loaded.picture, view, w, h, smooth);
  }, [loaded, view, smooth, stage?.width, stage?.height, wantSource]);

  // ── Gestures: one finger or the mouse pans, two fingers pinch (and pan), a double-tap toggles 1× ↔ 3×, the wheel zooms.
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const pointers = useRef(new Map<number, XY>());
  const gesture = useRef<{ kind: "pan"; start: InspectView; from: XY; id: number } | { kind: "pinch"; start: InspectView; from: [XY, XY]; ids: [number, number] } | null>(null);
  const tap = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  const lastTap = useRef<{ x: number; y: number; t: number } | null>(null);
  const local = (event: { clientX: number; clientY: number }): XY => {
    const r = surface.current!.getBoundingClientRect();
    return [event.clientX - r.left, event.clientY - r.top];
  };
  const begin = () => {
    const entries = [...pointers.current.entries()];
    if (entries.length >= 2) gesture.current = { kind: "pinch", start: viewRef.current, from: [entries[0][1], entries[1][1]], ids: [entries[0][0], entries[1][0]] };
    else if (entries.length === 1) gesture.current = { kind: "pan", start: viewRef.current, from: entries[0][1], id: entries[0][0] };
    else gesture.current = null;
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!stage || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = local(event);
    pointers.current.set(event.pointerId, p);
    if (pointers.current.size === 1) tap.current = { x: p[0], y: p[1], t: event.timeStamp, moved: false };
    else if (tap.current) tap.current.moved = true;
    begin();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!stage || !pointers.current.has(event.pointerId)) return;
    const p = local(event);
    pointers.current.set(event.pointerId, p);
    if (tap.current && Math.hypot(p[0] - tap.current.x, p[1] - tap.current.y) > TAP_SLOP) tap.current.moved = true;
    const g = gesture.current;
    if (g?.kind === "pan") dispatch({ type: "view", view: panBy(g.start, p[0] - g.from[0], p[1] - g.from[1], stage) });
    else if (g?.kind === "pinch") {
      const a = pointers.current.get(g.ids[0]), b = pointers.current.get(g.ids[1]);
      if (a && b) dispatch({ type: "view", view: pinchView(g.start, g.from, [a, b], stage) });
    }
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const t = tap.current;
    if (stage && t && pointers.current.size === 0 && event.type === "pointerup") {
      if (!t.moved && event.timeStamp - t.t < DOUBLE_TAP_MS * 2) {
        const last = lastTap.current;
        if (last && event.timeStamp - last.t < DOUBLE_TAP_MS && Math.hypot(t.x - last.x, t.y - last.y) < DOUBLE_TAP_PX) {
          dispatch({ type: "view", view: doubleTapView(viewRef.current, t.x, t.y, stage) });
          lastTap.current = null;
        } else lastTap.current = { x: t.x, y: t.y, t: event.timeStamp };
      } else lastTap.current = null;
    }
    if (pointers.current.size === 0) tap.current = null;
    begin();
  };
  useEffect(() => {
    const el = surface.current;
    if (!el || !stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const dy = (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1) * event.deltaY * (event.ctrlKey ? 4 : 1);
      dispatch({ type: "view", view: wheelView(viewRef.current, dy, ...local(event), stage) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stage?.width, stage?.height]);

  // Desktop keys: + and − zoom about the centre, 0 resets (the editor's arrows already step frames).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!stage || (event.target as HTMLElement).closest("input, textarea")) return;
      if (event.key === "+" || event.key === "=") dispatch({ type: "view", view: zoomAbout(viewRef.current, viewRef.current.zoom * 1.5, stage.width / 2, stage.height / 2, stage) });
      else if (event.key === "-") dispatch({ type: "view", view: zoomAbout(viewRef.current, viewRef.current.zoom / 1.5, stage.width / 2, stage.height / 2, stage) });
      else if (event.key === "0") dispatch({ type: "reset" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage]);

  // ── Actions
  const fps = REEL_FORMAT.fps;
  const step = (direction: -1 | 1) => onSeek(stepFrameMs(clock.get(), direction, totalMs, fps));
  const face = () => {
    if (!at || !info) return;
    const size = loaded?.key.startsWith(`${at.clip.id}|`) ? { width: loaded.width, height: loaded.height } : { width: info.width ?? REEL_FORMAT.width, height: info.height ?? REEL_FORMAT.height };
    dispatch({ type: "view", view: faceView(info.face, clipPicture(at.clip, size, at.moment)) });
  };
  const copy = async () => {
    if (!stage || mediaMs === null || !kind) return;
    // In Final the original may not have been asked for: the preview the editor plays is read instead.
    const file = src ?? (assetId ? assets[assetId]?.src : null);
    if (!file) return;
    setNote("Saving the frame…");
    const read = loaded?.key === key ? { status: "ready" as const, media: loaded.media, width: loaded.width, height: loaded.height } : await reader.read(file, kind, mediaMs);
    const moment = onScreenAt(timeline, now);
    if (read.status !== "ready" || !moment) { setNote("This frame could not be read."); return; }
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const out = document.createElement("canvas");
    out.width = Math.round(stage.width * dpr); out.height = Math.round(stage.height * dpr);
    const ctx = out.getContext("2d");
    if (!ctx) return;
    drawSourceView(ctx, read.media, clipPicture(moment.clip, { width: read.width, height: read.height }, moment.moment), view, out.width, out.height, smooth);
    out.toBlob((blob) => {
      if (!blob) { setNote("The frame could not be saved."); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = inspectFileName(now, view.zoom, "footage");
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNote(`Saved ${link.download}`);
      out.width = 0; out.height = 0;
    }, "image/png");
  };

  const sourceRect = loaded && wantSource ? visibleSourceRect(loaded.picture, view) : null;
  const message = note ?? (wantSource ? (loaded && loaded.key !== key ? "Loading the frame…" : loaded ? `Footage only: ${loaded.original ? "the original" : "the editor's copy"}, ${loaded.width}×${loaded.height}` : "Loading the frame…") : null);

  const bars = (
    <>
      <div className="inspect-bar" data-testid="inspect-bar" data-now={now.toFixed(3)}>
        <div className="inspect-tabs" role="tablist" aria-label="Layers">
          <button type="button" role="tab" aria-selected={layer === "final"} className={layer === "final" ? "inspect-btn is-current" : "inspect-btn"} data-testid="inspect-final" onClick={() => dispatch({ type: "layer", layer: "final" })}>Final</button>
          <button type="button" role="tab" aria-selected={layer === "footage"} className={layer === "footage" ? "inspect-btn is-current" : "inspect-btn"} data-testid="inspect-footage" onClick={() => dispatch({ type: "layer", layer: "footage" })}>Footage only</button>
        </div>
        <output className="inspect-zoom" data-testid="inspect-zoom" aria-label="Zoom">{zoomLabel(view.zoom)}</output>
        <button type="button" className="inspect-btn" data-testid="inspect-reset" disabled={view.zoom === 1} onClick={() => dispatch({ type: "reset" })}>1×</button>
        <button type="button" className="inspect-btn is-signal" data-testid="inspect-done" onClick={onClose}>Done</button>
      </div>
      <div className="inspect-tools" data-testid="inspect-tools">
        {message ? <p className="inspect-note" role="status">{message}</p> : null}
        <div className="inspect-row">
          <button type="button" className="inspect-btn" aria-label="Previous frame" data-testid="inspect-prev" onClick={() => step(-1)}>◀</button>
          <input type="range" className="inspect-scrub" aria-label="Scrub" data-testid="inspect-scrub" min={0} max={Math.max(0, totalMs - 1)} step="any" value={Math.min(now, Math.max(0, totalMs - 1))} onChange={(event) => onSeek(Number(event.target.value))}
            // Let go of the strip so the keys (I, +, -, 0) reach Inspect and the editor again.
            onPointerUp={(event) => event.currentTarget.blur()} />
          <button type="button" className="inspect-btn" aria-label="Next frame" data-testid="inspect-next" onClick={() => step(1)}>▶</button>
        </div>
        <div className="inspect-row is-chips">
          {info?.ai ? <button type="button" className="inspect-btn" data-testid="inspect-face" onClick={face}>Face</button> : null}
          <button type="button" className={smooth ? "inspect-btn" : "inspect-btn is-current"} aria-pressed={!smooth} data-testid="inspect-smoothing" onClick={() => dispatch({ type: "smoothing" })}>Pixels</button>
          <button type="button" className="inspect-btn" data-testid="inspect-copy" onClick={() => void copy()}>{wantSource ? "Copy frame" : "Copy footage"}</button>
        </div>
      </div>
    </>
  );

  const rect = plane ? { left: plane.left, top: plane.top, width: plane.width, height: plane.height } : { left: 0, top: 0, width: "100%", height: "100%" };
  return (
    <>
      {wantSource ? (
        <canvas ref={canvas} className="inspect-canvas" data-testid="inspect-canvas" style={{ ...rect, imageRendering: smooth ? "auto" : "pixelated" }}
          data-src={loaded?.src} data-seek-ms={loaded?.seekMs.toFixed(3)} data-reel-ms={loaded?.reelMs.toFixed(3)}
          data-source-size={loaded ? `${loaded.width},${loaded.height}` : undefined} data-original={loaded ? String(loaded.original) : undefined}
          data-source-rect={sourceRect ? [sourceRect.sx, sourceRect.sy, sourceRect.sw, sourceRect.sh].map((n) => n.toFixed(3)).join(",") : undefined} />
      ) : null}
      <div ref={surface} className="inspect-surface" data-testid="inspect-surface" style={rect}
        data-zoom={view.zoom.toFixed(4)} data-view={`${view.zoom.toFixed(4)},${view.cx.toFixed(5)},${view.cy.toFixed(5)}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        aria-label="Inspect: pinch or scroll to zoom, drag to look around, double-tap to zoom in or out" role="img" />
      {host ? createPortal(bars, host) : bars}
    </>
  );
}
