"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { prefetch } from "remotion";
import { calloutAnchorAt, compositionScale, emptyTimeline, INSTAGRAM, mapPoints, minTextSize, onScreenAt, pinnedProgress, PLANAR_MAX_WIDTH, planeFrame, planeMotion, REEL_FORMAT, stageRect, stackTitles, STILL_PLANE, storedFraction, maxTextSize, textsAt, textPositionAt, textQuadAt, tapSourceMs, viewportToComposition, type PlaneMotion, type TextOverlay, type Timeline, type ViewportRect, type XY } from "@reelwalk/core";
import { ReelComposition, reelDurationInFrames, textTreatmentCss, type ReelAsset } from "@reelwalk/render/reel";
import { timelineFrames } from "./frame-service";
import { pinnedLineFit } from "./title-metrics";
import { PlayIcon } from "../icons";
import { useClock, type Clock } from "./clock";
import { InspectMode, type InspectSource } from "./inspect";

type PreviewProps = {
  timeline: Timeline;
  assets: Record<string, ReelAsset>;
  /**
   * Media to download once and keep in memory. Without it every clip's
   * <video> is created fresh when playback reaches it and a phone buffers
   * the file again each time, for seconds; with it the Player plays the
   * in-memory copy and switching clips is instant.
   */
  prefetchSrcs: string[];
  /** Called with the Player when it mounts and with null when it unmounts. */
  playerRef(player: PlayerRef | null): void;
  playing: boolean;
  guides: boolean;
  selectedText: TextOverlay | null;
  clock: Clock;
  onTogglePlay(): void;
  onMoveText(id: string, x: number, y: number, gesture: string): void;
  onResizeText(id: string, size: number, gesture: string): void;
  /** The selected title's surface corners were dragged (frame fractions, tl tr br bl). */
  onSurfaceText?(id: string, quad: number[], gesture: string): void;
  /** The posts in front of the selected title's surface were dragged, added or removed (ADR 0044). */
  onBarsText?(id: string, bars: number[][], gesture: string): void;
  /** The cut-outs in front of the selected title's surface changed (ADR 0044). */
  onCutoutsText?(id: string, cutouts: number[][], gesture: string): void;
  /** The taps naming things in front of the selected title changed (ADR 0044). */
  onOccludersText?(id: string, occluders: { x: number; y: number }[], gesture: string): void;
  /** People in the shot pass in front of the selected title (the person matte). */
  onBehindText?(id: string, behind: boolean): void;
  /** The selected callout's point was dragged onto a feature (ADR 0061; frame fractions on its first frame). */
  onCalloutAnchorText?(id: string, x: number, y: number, gesture: string): void;
  onSelectText(id: string): void;
  onEditText(id: string): void;
  empty: React.ReactNode;
  /** Full-screen viewing: the frame fills the screen, editing handles hide. */
  theater?: boolean;
  onExitTheater?(): void;
  /** Check mode (ADR 0044): full screen with a strip of moments to jump to, every title's surface outlined. */
  check?: { marks: { label: string; ms: number }[]; onSeek(ms: number): void } | null;
  /** Corner placing (ADR 0044): full screen, only the selected title's corners and posts, a loupe under the finger; "cutouts" opens on the cut-out tool. */
  corners?: false | "corners" | "cutouts";
  onDoneCorners?(): void;
  /**
   * The placing screen's own check (ADR 0044): the shot's five moments to step through, and Track, which
   * follows the surface through the shot right there so the later moments show the tracked result.
   */
  placing?: { marks: { label: string; ms: number }[]; onSeek(ms: number): void; onTrack(): void; status: string | null; busy: boolean } | null;
  /** Inspect mode (ADR 0057): full screen on the placing layout, the frame magnified up to 8×, Final or Footage only. */
  inspect?: { sources: Record<string, InspectSource>; totalMs: number; onSeek(ms: number): void; onClose(): void } | null;
};

/** Snaps to the centre line when the text is dragged close to it. */
function snap(value: number): number {
  return Math.abs(value - 0.5) < 0.02 ? 0.5 : value;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Takes a pointer's viewport px; returns composition fraction. `plane` is the
 * element laid exactly over the composition (the Player's contain-fit inside
 * the stage, ADR 0047), so its box is the stage rect.
 */
function pointerToComposition(plane: HTMLElement, clientX: number, clientY: number): XY {
  const r = plane.getBoundingClientRect();
  return viewportToComposition({ left: r.left, top: r.top, width: r.width, height: r.height }, clientX, clientY);
}

/** Drags a point in composition fractions, calling `onMove` with the pointer's position on the composition while the pointer is down. */
function dragPoint(event: React.PointerEvent<HTMLButtonElement>, frame: RefObject<HTMLDivElement | null>, onMove: (x: number, y: number) => void, onEnd?: () => void) {
  if (event.button !== 0 || !frame.current) return;
  event.stopPropagation();
  event.currentTarget.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    const [x, y] = pointerToComposition(frame.current!, e.clientX, e.clientY);
    onMove(clamp(x, -0.5, 1.5), clamp(y, -0.5, 1.5));
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onEnd?.(); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

/** Displayed points (this frame) back to stored ones (the plane's first frame), rounded as the timeline keeps them. */
const toStored = (view: PlaneMotion, x: number, y: number): XY => view.toFirst(x, y).map(storedFraction) as XY;

const quadPoints = (quad: readonly number[]) => `${quad[0] * 100},${quad[1] * 100} ${quad[2] * 100},${quad[3] * 100} ${quad[4] * 100},${quad[5] * 100} ${quad[6] * 100},${quad[7] * 100}`;

/**
 * Where the selected title's plane is on screen at `now`: its tracked corners
 * on this frame, or null (the stored first-frame plane) when unpinned or on
 * another shot.
 *
 * SEAM (ADR 0047): W1's scene evaluator (packages/core/src/scene.ts) will
 * evaluate the placement ReelComposition draws. When it lands, return its
 * evaluated `plane` for this text at `now` here, so the handles and the
 * composition read one evaluation instead of two.
 */
function displayedPlane(timeline: Timeline, text: TextOverlay, now: number): number[] | null {
  return text.pin ? textQuadAt(text, pinnedProgress(timeline, text, now)) : null;
}

/**
 * The composition's picture at the playhead, from the frame service (ADR
 * 0047): the clip on screen drawn through its fit, zoom and move at the
 * media time the stage's own video is at. Null while it loads.
 */
const EMPTY_TIMELINE = emptyTimeline();
type StageMoment = { timeline: Timeline; assets: Record<string, ReelAsset>; now: number };
function useStageFrame({ timeline, assets, now }: StageMoment): HTMLCanvasElement | null {
  const frames = useMemo(() => timelineFrames(timeline, assets), [timeline, assets]);
  const at = onScreenAt(timeline, now);
  const clipId = at?.clip.id ?? null, mediaMs = at ? Number(at.mediaMs.toFixed(2)) : null;
  const [picture, setPicture] = useState<{ key: string; canvas: HTMLCanvasElement | null } | null>(null);
  const key = `${clipId}|${mediaMs}`;
  useEffect(() => {
    if (!clipId || mediaMs === null) return;
    let live = true;
    // Latest wins: dragging across a scrub never queues stale seeks behind the frame wanted now.
    frames.frameAt(clipId, mediaMs, { channel: "loupe" }).then((canvas) => { if (live) setPicture({ key, canvas }); });
    return () => { live = false; };
  }, [frames, clipId, mediaMs, key]);
  // A frame for another moment is never shown: the loupe stays black until this one is drawn.
  return picture?.key === key ? picture.canvas : null;
}

const LOUPE_SIZE = 150, LOUPE_ZOOM = 2.5;

/**
 * A magnifier above the finger while a corner is dragged (ADR 0044): the
 * footage around the point at two and a half times, with a cross-hair, so a
 * corner can be put on a wall's edge on a phone. Reads the frame service's
 * picture of the composition (ADR 0047), so a composition fraction is simply
 * a pixel of it, whatever the clip's fit, zoom or move.
 */
function Loupe({ stage, frame, x, y }: { stage: StageMoment | null; frame: RefObject<HTMLDivElement | null>; x: number; y: number }) {
  // Mounted only while a point is held, so a frame is decoded only then (ADR 0047: phones).
  const picture = useStageFrame(stage ?? { timeline: EMPTY_TIMELINE, assets: {}, now: 0 });
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const out = canvas.current, plane = frame.current;
    if (!out || !plane) return;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    const width = plane.getBoundingClientRect().width;
    if (picture && width > 0) {
      // Picture px per on-screen px; the picture and the plane are both the composition, so one ratio serves both axes.
      const span = (LOUPE_SIZE / LOUPE_ZOOM) * (picture.width / width);
      ctx.imageSmoothingQuality = "high";
      try { ctx.drawImage(picture, x * picture.width - span / 2, y * picture.height - span / 2, span, span, 0, 0, LOUPE_SIZE, LOUPE_SIZE); } catch { /* a frame freed by the cache: the black stays */ }
    }
    ctx.strokeStyle = "rgba(255,90,95,0.95)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(LOUPE_SIZE / 2, 0); ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE); ctx.moveTo(0, LOUPE_SIZE / 2); ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2); ctx.stroke();
  }, [picture, frame, x, y]);
  // Above the finger, kept inside the frame; below it near the top edge.
  const above = y > 0.22;
  return (
    <canvas ref={canvas} className="loupe" data-testid="loupe" width={LOUPE_SIZE} height={LOUPE_SIZE} aria-hidden="true"
      style={{ left: `calc(${Math.min(0.999, Math.max(0.001, x)) * 100}% - ${LOUPE_SIZE / 2}px)`, top: above ? `calc(${y * 100}% - ${LOUPE_SIZE + 48}px)` : `calc(${y * 100}% + 48px)` }} />
  );
}

/**
 * The plane's own grid, warped through the four corners: how a rectangle on
 * this surface leans and shrinks, visible before any text is fitted to it,
 * so a corner that makes the words warp thin shows as a grid that does.
 */
function PerspectiveGrid({ quad }: { quad: number[] }) {
  const plane = planeFrame(quad);
  if (!plane) return null;
  const at = (s: number, t: number) => { const [x, y] = plane.toComposition(s, t); return `${x * 100},${y * 100}`; };
  const lines: string[] = [];
  for (let i = 1; i < 4; i++) {
    lines.push(`${at(i / 4, 0)} ${at(i / 4, 1)}`);
    lines.push(`${at(0, i / 4)} ${at(1, i / 4)}`);
  }
  return <>{lines.map((points, i) => <polyline key={i} points={points} fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth={0.3} vectorEffect="non-scaling-stroke" />)}</>;
}

/**
 * The surface a title is painted on: a dashed outline with a numbered,
 * draggable corner at each of its four points, set by hand on the first
 * frame of the shot (ADR 0043, ADR 0044). While a corner is dragged, a
 * cross-hair through it helps land it on the wall's edge. Posts in front of
 * the surface (a mullion, a pole) are strips whose two edges drag sideways.
 */
function SurfaceHandles({ quad: stored, bars: storedBars = [], frame, onChange, onBars, large = false, view = STILL_PLANE, stage = null }: { quad: number[]; bars?: number[][]; frame: RefObject<HTMLDivElement | null>; onChange(quad: number[], gesture: string): void; onBars?(bars: number[][], gesture: string): void; large?: boolean; view?: PlaneMotion; stage?: StageMoment | null }) {
  const [active, setActive] = useState<{ x: number; y: number } | null>(null);
  // Shown where the plane is on this frame; stored (and edited) in the first frame's coordinates.
  const quad = mapPoints(stored, view.toNow), bars = storedBars.map((bar) => mapPoints(bar, view.toNow));
  return (
    <>
      {large && active ? <Loupe stage={stage} frame={frame} x={active.x} y={active.y} /> : null}
      <svg className="surface-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        <polygon points={quadPoints(quad)} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.85)" strokeWidth={0.4} strokeDasharray="1.2 0.8" vectorEffect="non-scaling-stroke" />
        {large ? <PerspectiveGrid quad={quad} /> : null}
        {bars.map((bar, i) => <polygon key={i} points={quadPoints(bar)} fill="rgba(20,20,20,0.45)" stroke="rgba(255,210,80,0.9)" strokeWidth={0.4} vectorEffect="non-scaling-stroke" />)}
        {active ? (<>
          <line x1={0} x2={100} y1={active.y * 100} y2={active.y * 100} stroke="rgba(255,90,95,0.9)" strokeWidth={0.3} vectorEffect="non-scaling-stroke" />
          <line y1={0} y2={100} x1={active.x * 100} x2={active.x * 100} stroke="rgba(255,90,95,0.9)" strokeWidth={0.3} vectorEffect="non-scaling-stroke" />
        </>) : null}
      </svg>
      {[0, 1, 2, 3].map((i) => (
        <button
          key={i}
          type="button"
          className={large ? "surface-corner is-large" : "surface-corner"}
          data-testid="surface-corner"
          aria-label={`Surface corner ${i + 1}, ${["top left", "top right", "bottom right", "bottom left"][i]}. Drag to the edge of the wall.`}
          style={{ left: `${quad[i * 2] * 100}%`, top: `${quad[i * 2 + 1] * 100}%` }}
          onPointerDown={(event) => {
            const gesture = `drag:surface-${i}:${Date.now()}`;
            dragPoint(event, frame, (x, y) => {
              const [fx, fy] = toStored(view, x, y);
              const next = [...stored]; next[i * 2] = fx; next[i * 2 + 1] = fy;
              setActive({ x, y });
              onChange(next, gesture);
            }, () => setActive(null));
          }}
        >{i + 1}</button>
      ))}
      {onBars ? bars.map((bar, b) => (
        <span key={b}>
          {[0, 1].map((side) => {
            // The left edge is corners 0 (top) and 3 (bottom); the right edge corners 1 and 2.
            const top = side === 0 ? 0 : 2, bottom = side === 0 ? 6 : 4;
            return (
              <button key={side} type="button" className="surface-bar-edge" data-testid="surface-bar-edge" aria-label={`Post ${b + 1}, ${side === 0 ? "left" : "right"} edge. Drag sideways onto the edge of the post.`}
                style={{ left: `${((bar[top] + bar[bottom]) / 2) * 100}%`, top: `${((bar[top + 1] + bar[bottom + 1]) / 2) * 100}%` }}
                onPointerDown={(event) => {
                  const gesture = `drag:bar-${b}-${side}:${Date.now()}`;
                  dragPoint(event, frame, (x, y) => {
                    const next = storedBars.map((q) => [...q]);
                    // The edge keeps its own top and bottom; only its x moves, taken back to the first frame at each end.
                    const [fx] = toStored(view, x, y);
                    next[b][top] = fx; next[b][bottom] = fx;
                    setActive({ x, y });
                    onBars(next, gesture);
                  }, () => setActive(null));
                }} />
            );
          })}
          <button type="button" className="surface-bar-remove" aria-label={`Remove post ${b + 1}`} style={{ left: `${((bar[0] + bar[2]) / 2) * 100}%`, top: `${Math.min(bar[1], bar[3]) * 100}%` }}
            onPointerDown={(event) => event.stopPropagation()} onClick={() => onBars(storedBars.filter((_, i) => i !== b), `bar-remove-${Date.now()}`)}>×</button>
        </span>
      )) : null}
    </>
  );
}

const polygonPoints = (points: readonly number[]) => Array.from({ length: points.length / 2 }, (_, i) => `${points[i * 2] * 100},${points[i * 2 + 1] * 100}`).join(" ");

/**
 * Cut-outs (ADR 0044): polygons drawn over things in front of the surface. A
 * new one is built by tapping its points in order; existing points drag, with
 * the loupe. Finish needs three points; the title is cut out inside each.
 */
function CutoutEditor({ cutouts: stored, frame, onChange, view = STILL_PLANE, stage = null }: { cutouts: number[][]; frame: RefObject<HTMLDivElement | null>; onChange(cutouts: number[][], gesture: string): void; view?: PlaneMotion; stage?: StageMoment | null }) {
  // Drafts are kept in first-frame coordinates too, so a shape begun on one frame reads right on another.
  const [draft, setDraft] = useState<number[] | null>(null);
  const [active, setActive] = useState<{ x: number; y: number } | null>(null);
  const drafting = draft !== null;
  const cutouts = stored.map((shape) => mapPoints(shape, view.toNow));
  const draftShown = draft ? mapPoints(draft, view.toNow) : null;
  const place = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drafting || !frame.current || event.button !== 0) return;
    const [x, y] = toStored(view, ...pointerToComposition(frame.current, event.clientX, event.clientY));
    setDraft([...(draft ?? []), x, y]);
  };
  const finish = () => {
    if (!draft || draft.length < 6) return;
    onChange([...stored, draft], `cutout-add-${Date.now()}`);
    setDraft(null);
  };
  return (
    <>
      {active ? <Loupe stage={stage} frame={frame} x={active.x} y={active.y} /> : null}
      {drafting ? <div className="cutout-canvas" data-testid="cutout-canvas" onPointerDown={place} /> : null}
      <svg className="surface-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        {cutouts.map((shape, i) => <polygon key={i} points={polygonPoints(shape)} fill="rgba(20,20,20,0.45)" stroke="rgba(120,200,255,0.95)" strokeWidth={0.4} vectorEffect="non-scaling-stroke" />)}
        {draftShown && draftShown.length >= 4 ? <polyline points={polygonPoints(draftShown)} fill={draftShown.length >= 6 ? "rgba(120,200,255,0.15)" : "none"} stroke="rgba(120,200,255,0.95)" strokeWidth={0.4} strokeDasharray="1.2 0.8" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {cutouts.map((shape, c) => (
        <span key={c}>
          {Array.from({ length: shape.length / 2 }, (_, i) => (
            <button key={i} type="button" className="cutout-point" data-testid="cutout-point" aria-label={`Cut-out ${c + 1}, point ${i + 1}. Drag onto the object's edge.`}
              style={{ left: `${shape[i * 2] * 100}%`, top: `${shape[i * 2 + 1] * 100}%` }}
              onPointerDown={(event) => {
                const gesture = `drag:cutout-${c}-${i}:${Date.now()}`;
                dragPoint(event, frame, (x, y) => {
                  const [fx, fy] = toStored(view, x, y);
                  const next = stored.map((q) => [...q]);
                  next[c][i * 2] = fx; next[c][i * 2 + 1] = fy;
                  setActive({ x, y });
                  onChange(next, gesture);
                }, () => setActive(null));
              }} />
          ))}
          <button type="button" className="surface-bar-remove" aria-label={`Remove cut-out ${c + 1}`}
            style={{ left: `${(shape.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / (shape.length / 2)) * 100}%`, top: `${Math.min(...shape.filter((_, i) => i % 2 === 1)) * 100}%` }}
            onPointerDown={(event) => event.stopPropagation()} onClick={() => onChange(stored.filter((_, i) => i !== c), `cutout-remove-${Date.now()}`)}>×</button>
        </span>
      ))}
      {draftShown ? Array.from({ length: draftShown.length / 2 }, (_, i) => (
        <span key={i} className="cutout-point is-draft" style={{ left: `${draftShown[i * 2] * 100}%`, top: `${draftShown[i * 2 + 1] * 100}%` }} aria-hidden="true" />
      )) : null}
      <div className="cutout-tools" data-testid="cutout-tools">
        {drafting ? (<>
          <span className="small">{draft!.length < 6 ? `Tap the object's corners (${draft!.length / 2} of at least 3)` : `${draft!.length / 2} points. Tap more, or finish.`}</span>
          <button type="button" className="btn btn-quiet" disabled={!draft!.length} onClick={() => setDraft(draft!.slice(0, -2))}>Undo point</button>
          <button type="button" className="btn btn-quiet" onClick={() => setDraft(null)}>Cancel</button>
          <button type="button" className="btn btn-signal" disabled={draft!.length < 6} data-testid="cutout-finish" onClick={finish}>Finish</button>
        </>) : (<>
          <span className="small">{stored.length ? `${stored.length} cut-out${stored.length === 1 ? "" : "s"}. Drag points; × removes one.` : "Nothing cut out yet."}</span>
          <button type="button" className="btn btn-signal" disabled={stored.length >= 12} data-testid="cutout-add" onClick={() => setDraft([])}>Add a cut-out</button>
        </>)}
      </div>
    </>
  );
}

/**
 * Things in front, by tapping (ADR 0044): a tap on the frame names an object;
 * the segmenter cuts it out on every frame and the title goes behind it. Taps
 * are stored in first-frame coordinates and shown where the plane carries
 * them. Drawing a shape by hand remains for what the segmenter cannot find.
 */
function OccluderEditor({ text, frame, view, atMs, stage, onOccluders, onCutouts, onBehind }: { text: TextOverlay; frame: RefObject<HTMLDivElement | null>; view: PlaneMotion; /** The pinned source time on screen: where the tracker starts from (ADR 0051). */ atMs: number | null; stage: StageMoment; onOccluders(occluders: NonNullable<TextOverlay["occluders"]>, gesture: string): void; onCutouts?(cutouts: number[][], gesture: string): void; onBehind?(behind: boolean): void }) {
  const [byHand, setByHand] = useState(false);
  const taps = text.occluders ?? [];
  const tap = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!frame.current || event.button !== 0 || taps.length >= 4) return;
    const [x, y] = toStored(view, ...pointerToComposition(frame.current, event.clientX, event.clientY));
    onOccluders([...taps, { x, y, ...(atMs === null ? {} : { atMs }) }], `occluder-add-${Date.now()}`);
  };
  if (byHand && onCutouts) {
    return (<>
      <CutoutEditor cutouts={text.cutouts ?? []} frame={frame} onChange={onCutouts} view={view} stage={stage} />
      <button type="button" className="btn btn-quiet occluder-mode" onClick={() => setByHand(false)}>Back to tapping</button>
    </>);
  }
  return (
    <>
      <div className="cutout-canvas" data-testid="occluder-canvas" onPointerDown={tap} />
      {taps.map((point, i) => {
        const [x, y] = view.toNow(point.x, point.y);
        return (
          <button key={i} type="button" className="occluder-tap" data-testid="occluder-tap" aria-label={`Remove tap ${i + 1}`} style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
            onPointerDown={(event) => event.stopPropagation()} onClick={() => onOccluders(taps.filter((_, k) => k !== i), `occluder-remove-${Date.now()}`)}>×</button>
        );
      })}
      <div className="cutout-tools" data-testid="occluder-tools">
        <span className="small">{taps.length ? `${taps.length} tapped. The title goes behind what is under each tap; tap a mark to remove it.` : "Tap the plant, chair or railing the title should go behind. Up to four taps."}</span>
        {onBehind ? <button type="button" className={text.behind ? "check-mark is-current" : "check-mark"} aria-pressed={Boolean(text.behind)} data-testid="behind-toggle" onClick={() => onBehind(!text.behind)}>People in front</button> : null}
        {onCutouts ? <button type="button" className="btn btn-quiet" data-testid="by-hand" onClick={() => setByHand(true)}>{text.cutouts?.length ? `Drawn shapes (${text.cutouts.length})` : "Draw by hand"}</button> : null}
      </div>
    </>
  );
}

/**
 * The placing screen's frame overlay: the selected title's corners and posts,
 * or its cut-outs, shown where the tracked plane puts them on this frame and
 * editable there. A drag is taken back to the first frame's coordinates
 * through the plane's motion, so one move on any frame moves the whole track.
 */
function PlacingOverlay({ clock, timeline, assets, text, frame, tool, onSurface, onBars, onCutouts, onOccluders, onBehind }: { clock: Clock; timeline: Timeline; assets: Record<string, ReelAsset>; text: TextOverlay; frame: RefObject<HTMLDivElement | null>; tool: "corners" | "cutouts"; onSurface(quad: number[], gesture: string): void; onBars?(bars: number[][], gesture: string): void; onCutouts?(cutouts: number[][], gesture: string): void; onOccluders?(occluders: { x: number; y: number }[], gesture: string): void; onBehind?(behind: boolean): void }) {
  const now = useClock(clock);
  const stage: StageMoment = { timeline, assets, now };
  const tracked = displayedPlane(timeline, text, now);
  // ADR 0052: while the tracked surface is lost (o = 0) its corners are not measured; no handles to drag through them.
  // Keep this after every hook (ADR 0047): returning before one crashes React when scrubbing into a lost stretch.
  if (tracked && textPositionAt(text, pinnedProgress(timeline, text, now)).opacity <= 0) return null;
  const view = planeMotion(text.pin?.quad, tracked);
  if (tool === "cutouts") {
    if (onOccluders) return <OccluderEditor text={text} frame={frame} view={view} atMs={tapSourceMs(timeline, text, now)} stage={stage} onOccluders={onOccluders} onCutouts={onCutouts} onBehind={onBehind} />;
    return onCutouts ? <CutoutEditor cutouts={text.cutouts ?? []} frame={frame} onChange={onCutouts} view={view} stage={stage} /> : null;
  }
  return <SurfaceHandles large quad={text.surface!} bars={text.bars} frame={frame} onChange={onSurface} onBars={onBars} view={view} stage={stage} />;
}

/** Check mode: every title on screen now, its surface (tracked where it is pinned) outlined, so a drift or a miss shows at full size before an export (ADR 0044). */
function SurfaceOutlines({ clock, timeline }: { clock: Clock; timeline: Timeline }) {
  const now = useClock(clock);
  const shapes = textsAt(timeline, now).flatMap((text) => {
    const quad = displayedPlane(timeline, text, now);
    // ADR 0052: a lost stretch of a track (o = 0) has no measured corners to outline.
    if (quad && textPositionAt(text, pinnedProgress(timeline, text, now)).opacity <= 0) return [];
    const outline = quad ?? text.surface;
    return outline ? [{ id: text.id, outline, tracked: Boolean(quad) }] : [];
  });
  if (!shapes.length) return null;
  return (
    <svg className="surface-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" data-testid="check-outlines" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
      {shapes.map((shape) => <polygon key={shape.id} points={quadPoints(shape.outline)} fill="none" stroke={shape.tracked ? "rgba(120,255,160,0.9)" : "rgba(255,255,255,0.8)"} strokeWidth={0.4} strokeDasharray="1.2 0.8" vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}

/** The moments to look at in check mode: a button per mark, the one nearest the playhead lit. */
function CheckStrip({ clock, marks, onSeek }: { clock: Clock; marks: { label: string; ms: number }[]; onSeek(ms: number): void }) {
  const now = useClock(clock);
  const nearest = marks.reduce((best, mark, i) => (Math.abs(mark.ms - now) < Math.abs(marks[best].ms - now) ? i : best), 0);
  return (
    <div className="check-strip" data-testid="check-strip">
      {marks.map((mark, i) => (
        <button key={i} type="button" className={i === nearest ? "check-mark is-current" : "check-mark"} aria-label={`Show ${mark.label}`} aria-pressed={i === nearest} onClick={() => onSeek(mark.ms)}>
          {mark.label}
        </button>
      ))}
    </div>
  );
}

/** An invisible copy of the text at preview scale, which gives a box the text's exact size. */
function Ghost({ text, scale }: { text: TextOverlay; scale: number }) {
  const css = textTreatmentCss(text);
  return (
    // As wide as the words, up to the width the reel wraps text at, so the box hugs the text.
    // A pinned title never wraps and is shrunk to the frame instead, so its box is its one line at that scale.
    <span style={{ display: "block", zoom: scale, width: "max-content", maxWidth: text.pin ? REEL_FORMAT.width * PLANAR_MAX_WIDTH : REEL_FORMAT.width * 0.86, pointerEvents: "none" }}>
      <span style={{ ...css, display: "inline-block", color: "transparent", background: "transparent", textShadow: "none", WebkitTextStroke: "0", ...(text.pin && !text.callout ? { whiteSpace: "nowrap", transform: `scale(${pinnedLineFit(text)})`, transformOrigin: "0 0" } : {}) }}>
        {text.text}
      </span>
    </span>
  );
}

/**
 * The selected text's box: drag it to move (it keeps the spot you grabbed),
 * drag the corner to resize, double-click to edit the words.
 */
function TextHandle({
  text,
  clock,
  scale,
  frame,
  onMove,
  onResize,
  onEdit,
}: {
  text: TextOverlay;
  clock: Clock;
  scale: number;
  frame: RefObject<HTMLDivElement | null>;
  onMove(x: number, y: number, gesture: string): void;
  onResize(size: number, gesture: string): void;
  onEdit(): void;
}) {
  const grab = useRef<{ dx: number; dy: number; gesture: string } | null>(null);
  const now = useClock(clock);
  const position = textPositionAt(text, (now - text.startMs) / (text.endMs - text.startMs));
  return (
    <button
      type="button"
      className="text-handle"
      aria-label={`Move text "${text.text}". Drag to place it, drag the corner to resize, double-click to edit.`}
      style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%` }}
      onDoubleClick={onEdit}
      onPointerDown={(event) => {
        if (event.button !== 0 || !frame.current) return;
        const [x, y] = pointerToComposition(frame.current, event.clientX, event.clientY);
        grab.current = {
          dx: x - text.x,
          dy: y - text.y,
          gesture: `drag:move-${text.id}:${Date.now()}`,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!grab.current || !event.currentTarget.hasPointerCapture(event.pointerId) || !frame.current) return;
        const [px, py] = pointerToComposition(frame.current, event.clientX, event.clientY);
        const x = clamp(px - grab.current.dx, 0.05, 0.95);
        const y = clamp(py - grab.current.dy, 0.05, 0.95);
        onMove(snap(x), y, grab.current.gesture);
      }}
      onPointerUp={() => (grab.current = null)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 0.05 : 0.01;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        if (event.key === "+" || event.key === "=" || event.key === "-") {
          event.preventDefault();
          onResize(clamp(Math.round((text.size + (event.key === "-" ? -0.1 : 0.1)) * 20) / 20, minTextSize(text.style), maxTextSize(text)), `size-${text.id}`);
          return;
        }
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        onMove(clamp(text.x + move[0], 0.05, 0.95), clamp(text.y + move[1], 0.05, 0.95), `move-${text.id}`);
      }}
    >
      <Ghost text={text} scale={scale} />
      <span
        className="text-resize"
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          const box = event.currentTarget.parentElement!.getBoundingClientRect();
          const cx = box.left + box.width / 2;
          const cy = box.top + box.height / 2;
          const from = Math.hypot(event.clientX - cx, event.clientY - cy) || 1;
          const size = text.size;
          const gesture = `drag:size-${text.id}:${Date.now()}`;
          const move = (e: PointerEvent) =>
            onResize(clamp(Math.round(((size * Math.hypot(e.clientX - cx, e.clientY - cy)) / from) * 20) / 20, minTextSize(text.style), maxTextSize(text)), gesture);
          const end = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end);
          window.addEventListener("pointercancel", end);
        }}
      />
    </button>
  );
}

/**
 * A callout's point (ADR 0061): a dot to drag onto the feature the label names. Shown where the point is on this
 * frame; dragging it sets the point on the title's first frame, so a pin made before is dropped by the editor.
 */
function CalloutAnchorHandle({ text, timeline, clock, frame, onMove }: { text: TextOverlay; timeline: Timeline; clock: Clock; frame: RefObject<HTMLDivElement | null>; onMove(x: number, y: number, gesture: string): void }) {
  const now = useClock(clock);
  const at = calloutAnchorAt(text, text.pin ? pinnedProgress(timeline, text, now) : 0);
  return (
    <button type="button" className="callout-anchor" data-testid="callout-anchor" aria-label={`The point "${text.text}" points at. Drag it onto the feature.`}
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
      onPointerDown={(event) => {
        const gesture = `drag:callout-${text.id}:${Date.now()}`;
        dragPoint(event, frame, (x, y) => onMove(storedFraction(x), storedFraction(y), gesture));
      }} />
  );
}

/** While paused, the texts on screen can be tapped to select them. */
function TextTargets({
  clock,
  timeline,
  selectedId,
  scale,
  onSelect,
  onEdit,
}: {
  clock: Clock;
  timeline: Timeline;
  selectedId: string | null;
  scale: number;
  onSelect(id: string): void;
  onEdit(id: string): void;
}) {
  const now = useClock(clock);
  return (
    <>
      {/* Stacked as the composition draws them (ADR 0046), so a tap lands on the title that is on top. */}
      {stackTitles(textsAt(timeline, now))
        .filter((text) => text.id !== selectedId)
        .map((text) => (
          <button
            key={text.id}
            type="button"
            className="text-hit"
            aria-label={`Select text "${text.text}"`}
            data-testid="text-target"
            style={{ left: `${textPositionAt(text, (now - text.startMs) / (text.endMs - text.startMs)).x * 100}%`, top: `${textPositionAt(text, (now - text.startMs) / (text.endMs - text.startMs)).y * 100}%` }}
            onClick={() => onSelect(text.id)}
            onDoubleClick={() => onEdit(text.id)}
          >
            <Ghost text={text} scale={scale} />
          </button>
        ))}
    </>
  );
}

export function Preview({
  timeline,
  assets,
  prefetchSrcs,
  playerRef,
  playing,
  guides,
  selectedText,
  clock,
  onTogglePlay,
  onMoveText,
  onResizeText,
  onSurfaceText,
  onBarsText,
  onCutoutsText,
  onOccludersText,
  onBehindText,
  onCalloutAnchorText,
  onSelectText,
  onEditText,
  empty,
  theater = false,
  onExitTheater,
  check = null,
  corners = false,
  onDoneCorners,
  placing = null,
  inspect = null,
}: PreviewProps) {
  const frame = useRef<HTMLDivElement>(null);
  // The composition's own rectangle inside the stage (ADR 0047): the Player contain-fits 9:16 into the
  // stage box, which is not 9:16 in full screen on a phone. Every handle is placed in this rectangle.
  const plane = useRef<HTMLDivElement>(null);
  const [planeRect, setPlaneRect] = useState<ViewportRect | null>(null);
  const scale = planeRect ? compositionScale(planeRect) : 0.3;
  // Which full-screen tool is up: the corners (and posts), or the cut-outs. Starts on what opened it.
  const [tool, setTool] = useState<"corners" | "cutouts">("corners");
  useEffect(() => { if (corners) setTool(corners); }, [corners]);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setPlaneRect(stageRect({ left: 0, top: 0, width: entry.contentRect.width, height: entry.contentRect.height })));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keep one in-memory copy per source. A source that drops out (a deleted
  // clip, a swapped preview) is freed a minute later, not at once: a <video>
  // may still be showing it, and undo often brings it straight back.
  const prefetched = useRef(new Map<string, { free: () => void; expiry: ReturnType<typeof setTimeout> | null }>());
  const prefetchKey = JSON.stringify(prefetchSrcs);
  useEffect(() => {
    const map = prefetched.current;
    const wanted = new Set(JSON.parse(prefetchKey) as string[]);
    for (const src of wanted) {
      const held = map.get(src);
      if (held) {
        if (held.expiry) clearTimeout(held.expiry);
        held.expiry = null;
        continue;
      }
      const { free, waitUntilDone } = prefetch(src, { method: "blob-url" });
      // A failed prefetch only means the clip streams as before.
      waitUntilDone().catch(() => undefined);
      map.set(src, { free, expiry: null });
    }
    for (const [src, held] of map) {
      if (wanted.has(src) || held.expiry) continue;
      held.expiry = setTimeout(() => {
        held.free();
        map.delete(src);
      }, 60_000);
    }
  }, [prefetchKey]);
  useEffect(() => {
    const map = prefetched.current;
    return () => {
      for (const held of map.values()) {
        if (held.expiry) clearTimeout(held.expiry);
        held.free();
      }
      map.clear();
    };
  }, []);

  // Full screen: the browser's own where it exists (desktop, Android), a
  // full-window overlay elsewhere (iPhone Safari cannot full-screen a div).
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!theater) return;
    const el = stage.current;
    if (el && document.fullscreenEnabled && !document.fullscreenElement) el.requestFullscreen().catch(() => undefined);
    const onChange = () => {
      if (!document.fullscreenElement) onExitTheater?.();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExitTheater?.();
    };
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    };
  }, [theater, onExitTheater]);

  const hasClips = timeline.clips.length > 0;
  const zone = INSTAGRAM.safeZonePx;
  // A full-screen tool (placing or Inspect) owns the frame: no tap-to-play, no play badge.
  const inspecting = theater && Boolean(inspect);
  const tooling = theater && (Boolean(corners) || inspecting);

  return (
    <div className={inspecting ? "stage stage-theater is-placing is-inspecting" : theater ? (corners ? "stage stage-theater is-placing" : "stage stage-theater") : "stage"} ref={stage}>
      {theater && corners ? (
        <div className="corners-bar" data-testid="corners-bar">
          <div className="corners-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tool === "corners"} className={tool === "corners" ? "check-mark is-current" : "check-mark"} onClick={() => setTool("corners")}>Corners</button>
            <button type="button" role="tab" aria-selected={tool === "cutouts"} className={tool === "cutouts" ? "check-mark is-current" : "check-mark"} onClick={() => setTool("cutouts")} data-testid="tool-cutouts">In front</button>
          </div>
          <span className="small">{tool === "corners" ? "Drag the corners on any frame; the whole track follows." : "Tap what the title should go behind."}</span>
          {placing ? <button type="button" className="btn" disabled={placing.busy} onClick={placing.onTrack} data-testid="placing-track">{placing.busy ? "Tracking…" : "Track"}</button> : null}
          <button type="button" className="btn btn-signal" onClick={() => onDoneCorners?.()} data-testid="corners-done">Done</button>
        </div>
      ) : theater && !inspecting ? (
        <button type="button" className="theater-close" aria-label="Exit full screen" onClick={() => onExitTheater?.()} data-testid="preview-fullscreen-close">
          ×
        </button>
      ) : null}
      {theater && check ? <CheckStrip clock={clock} marks={check.marks} onSeek={check.onSeek} /> : null}
      {theater && corners && placing ? (
        <div className="placing-strip" data-testid="placing-strip">
          {placing.status ? <p className="small placing-status" role="status">{placing.status}</p> : null}
          <CheckStrip clock={clock} marks={placing.marks} onSeek={placing.onSeek} />
        </div>
      ) : null}
      <div className="stage-frame" ref={frame} data-testid="preview">
        {hasClips ? (
          <>
            <Player
              ref={playerRef}
              className="player"
              component={ReelComposition}
              inputProps={{ timeline, assets }}
              durationInFrames={reelDurationInFrames(timeline, REEL_FORMAT.fps)}
              fps={REEL_FORMAT.fps}
              compositionWidth={REEL_FORMAT.width}
              compositionHeight={REEL_FORMAT.height}
              style={{ width: "100%", height: "100%" }}
              controls={false}
              clickToPlay={false}
              doubleClickToFullscreen={false}
              spaceKeyToPlayOrPause={false}
              moveToBeginningWhenEnded
              acknowledgeRemotionLicense
            />
            {tooling ? null : (
              <button
                type="button"
                className="stage-tap"
                aria-label={playing ? "Pause" : "Play"}
                onClick={onTogglePlay}
              />
            )}
            {!playing && !tooling ? (
              <span className="play-badge">
                <PlayIcon size={30} />
              </span>
            ) : null}
          </>
        ) : (
          <div className="stage-empty">{empty}</div>
        )}

        <div className="stage-plane" ref={plane} data-testid="stage-plane" style={planeRect ? { left: planeRect.left, top: planeRect.top, width: planeRect.width, height: planeRect.height } : { inset: 0 }}>
          {guides && !theater ? (
            <div className="guides" aria-hidden="true">
              <span className="g-top" style={{ height: `${(zone.top / REEL_FORMAT.height) * 100}%` }} />
              <span className="g-bottom" style={{ height: `${(zone.bottom / REEL_FORMAT.height) * 100}%` }} />
              <span
                className="g-right"
                style={{
                  top: `${(zone.top / REEL_FORMAT.height) * 100}%`,
                  bottom: `${(zone.bottom / REEL_FORMAT.height) * 100}%`,
                  width: `${(zone.right / REEL_FORMAT.width) * 100}%`,
                }}
              />
              <p>Instagram covers the shaded areas</p>
            </div>
          ) : null}

          {hasClips && !playing && !theater ? (
            <TextTargets clock={clock} timeline={timeline} selectedId={selectedText?.id ?? null} scale={scale} onSelect={onSelectText} onEdit={onEditText} />
          ) : null}
          {theater && corners && selectedText?.surface && onSurfaceText ? (
            <PlacingOverlay clock={clock} timeline={timeline} assets={assets} text={selectedText} frame={plane} tool={tool}
              onSurface={(quad, gesture) => onSurfaceText(selectedText.id, quad, gesture)}
              onBars={onBarsText ? (bars, gesture) => onBarsText(selectedText.id, bars, gesture) : undefined}
              onCutouts={onCutoutsText ? (cutouts, gesture) => onCutoutsText(selectedText.id, cutouts, gesture) : undefined}
              onOccluders={onOccludersText ? (occluders, gesture) => onOccludersText(selectedText.id, occluders, gesture) : undefined}
              onBehind={onBehindText ? (behind) => onBehindText(selectedText.id, behind) : undefined} />
          ) : null}
          {selectedText && !playing && !theater ? (<>
            <TextHandle
              text={selectedText}
              clock={clock}
              scale={scale}
              frame={plane}
              onMove={(x, y, gesture) => onMoveText(selectedText.id, x, y, gesture)}
              onResize={(size, gesture) => onResizeText(selectedText.id, size, gesture)}
              onEdit={() => onEditText(selectedText.id)}
            />
            {selectedText.callout && onCalloutAnchorText ? (
              <CalloutAnchorHandle text={selectedText} timeline={timeline} clock={clock} frame={plane} onMove={(x, y, gesture) => onCalloutAnchorText(selectedText.id, x, y, gesture)} />
            ) : null}
            {selectedText.surface && onSurfaceText ? (
              <SurfaceHandles quad={selectedText.surface} bars={selectedText.bars} frame={plane} onChange={(quad, gesture) => onSurfaceText(selectedText.id, quad, gesture)} onBars={onBarsText ? (bars, gesture) => onBarsText(selectedText.id, bars, gesture) : undefined} />
            ) : null}
          </>) : null}
          {theater && check ? <SurfaceOutlines clock={clock} timeline={timeline} /> : null}
        </div>
        {inspecting && inspect && hasClips ? (
          // The stage element is mounted long before Inspect opens, so its ref is set here.
          <InspectMode clock={clock} timeline={timeline} assets={assets} sources={inspect.sources} frame={frame} plane={planeRect} host={stage.current}
            totalMs={inspect.totalMs} onSeek={inspect.onSeek} onClose={inspect.onClose} />
        ) : null}
      </div>
    </div>
  );
}
