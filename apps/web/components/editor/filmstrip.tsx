"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clipDurationMs,
  clipEdgeWindow,
  clipStartsMs,
  retimeText,
  snapTime,
  timelineDurationMs,
  trimClip,
  type Clip,
  type DragEdge,
  type TextOverlay,
  type Timeline,
} from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { formatDuration } from "@/lib/format";
import { MusicIcon, PlusIcon, TextIcon } from "../icons";
import type { Clock } from "./clock";

export type Selection = { kind: "clip"; id: string } | { kind: "text"; id: string } | { kind: "music" } | null;

export type PendingUpload = { key: string; name: string; progress: number; thumbUrl: string | null; error?: string };

/** Pixels per second of reel at the default zoom, and the zoom range. */
export const PPS = 56;
const MIN_PPS = 12;
const MAX_PPS = 280;
const clampPps = (value: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, value));
const UPLOAD_WIDTH = 72;
/** How close, in pixels, a dragged edge has to come to a cut or the playhead to stick to it. */
const SNAP_PX = 8;
const LANE_ROW = 28;
const seconds1 = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

type FilmstripProps = {
  timeline: Timeline;
  library: Record<string, LibraryAsset>;
  uploads: PendingUpload[];
  selection: Selection;
  clock: Clock;
  onSelect(selection: Selection): void;
  /** Double-click or double-tap: select and open the item's main sheet. */
  onOpen(selection: Selection): void;
  onSeek(ms: number): void;
  /** Select without moving the playhead, for a drag that starts on an unselected item. */
  onGrab(selection: Selection): void;
  onScrub(ms: number): void;
  /** One call per pointer move; calls with the same gesture make one undo step. */
  onTextTiming(id: string, timing: { startMs: number; endMs: number }, gesture: string): void;
  onClipTrim(id: string, window: { sourceStartMs: number; sourceEndMs: number }, gesture: string): void;
  onMoveClip(id: string, toIndex: number): void;
  onAddMedia(): void;
  onAddText(): void;
  onAddMusic(): void;
};

/**
 * The timeline, drawn as a scale rule. The playhead stays in the middle and
 * the reel scrolls underneath it, the way phone editors work: drag the strip
 * to scrub, and it scrolls by itself during playback.
 */
export function Filmstrip({
  timeline,
  library,
  uploads,
  selection,
  clock,
  onSelect,
  onOpen,
  onSeek,
  onGrab,
  onScrub,
  onTextTiming,
  onClipTrim,
  onMoveClip,
  onAddMedia,
  onAddText,
  onAddMusic,
}: FilmstripProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState(180);
  const programmatic = useRef<number | null>(null);
  // Zoom: pixels per second. Pinch on a phone, Ctrl + wheel or a trackpad pinch on a computer, or the +/- buttons.
  const [pps, setPps] = useState(PPS);
  const ppsRef = useRef(pps);
  ppsRef.current = pps;

  const total = timelineDurationMs(timeline);
  const starts = clipStartsMs(timeline);
  const px = (ms: number) => (ms * pps) / 1000;
  const totalPx = px(total);
  const uploadsPx = uploads.length * (UPLOAD_WIDTH + 4);

  // Half the visible width on each side, so time 0 and the end can both reach the centre line.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setPad(Math.round(entry.contentRect.width / 2)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Playhead -> scroll position, without re-rendering this component on every frame.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const apply = (ms: number) => {
      const left = Math.round((ms * ppsRef.current) / 1000);
      if (Math.abs(element.scrollLeft - left) < 1) return;
      programmatic.current = left;
      element.scrollLeft = left;
    };
    apply(clock.get());
    return clock.subscribe((ms, source) => {
      if (source !== "scrub") apply(ms);
    });
  }, [clock]);

  // A new zoom keeps the playhead where it was.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const left = Math.round((clock.get() * pps) / 1000);
    programmatic.current = left;
    element.scrollLeft = left;
  }, [pps, clock]);

  const zoom = useCallback((factor: number) => setPps((current) => clampPps(current * factor)), []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoom(Math.exp(-event.deltaY * 0.01));
    };
    let pinch: { distance: number; pps: number } | null = null;
    const spread = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) pinch = { distance: spread(event.touches), pps: ppsRef.current };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      setPps(clampPps((pinch.pps * spread(event.touches)) / pinch.distance));
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [zoom]);

  // Scroll position -> playhead, when the user drags the strip.
  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    if (programmatic.current !== null && Math.abs(element.scrollLeft - programmatic.current) <= 1) {
      programmatic.current = null;
      return;
    }
    programmatic.current = null;
    onScrub(Math.min(total, Math.max(0, (element.scrollLeft * 1000) / pps)));
  }

  // ── Dragging edges ──────────────────────────────────────────
  const [dragging, setDragging] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const snapMs = (SNAP_PX * 1000) / pps;

  /**
   * Follow a pointer from a grip until it is released. onMove gets the
   * distance in reel milliseconds. With follow on, the strip scrolls by itself
   * when the pointer nears either side, and that scroll counts as distance.
   */
  function startDrag(
    event: React.PointerEvent<HTMLElement>,
    id: string,
    onMove: (deltaMs: number) => void,
    { follow = true, onStart, onEnd }: { follow?: boolean; onStart?: () => void; onEnd?: (moved: boolean) => void } = {},
  ) {
    const element = scroller.current;
    if (!element || event.button !== 0) return;
    event.stopPropagation();
    const startX = event.clientX;
    const startLeft = element.scrollLeft;
    let pointerX = startX;
    let moved = false;
    let frame = 0;
    const update = () => onMove(((pointerX - startX + (follow ? element.scrollLeft - startLeft : 0)) * 1000) / ppsRef.current);
    const edgeScroll = () => {
      // Only once the pointer has travelled into a side zone: on a phone an
      // edge often starts there, and scrolling straight away would run it off.
      // Speed grows with how deep into the zone it goes.
      const box = element.getBoundingClientRect();
      const zone = 44;
      const step =
        pointerX < box.left + zone && pointerX < startX - 8
          ? -Math.ceil((8 * (box.left + zone - pointerX)) / zone)
          : pointerX > box.right - zone && pointerX > startX + 8
            ? Math.ceil((8 * (pointerX - box.right + zone)) / zone)
            : 0;
      if (step) {
        element.scrollLeft += step;
        update();
      }
      frame = requestAnimationFrame(edgeScroll);
    };
    const move = (e: PointerEvent) => {
      pointerX = e.clientX;
      if (!moved && Math.abs(pointerX - startX) < 4) return;
      if (!moved) {
        moved = true;
        setDragging(id);
        onStart?.();
        if (follow) frame = requestAnimationFrame(edgeScroll);
      }
      update();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      cancelAnimationFrame(frame);
      setDragging(null);
      onEnd?.(moved);
      if (moved) {
        // The click that follows the release must not toggle the selection.
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function grabText(event: React.PointerEvent<HTMLElement>, text: TextOverlay, edge: DragEdge) {
    const selected = selectedId === text.id;
    // Touch scrolls the strip unless the text is selected; a mouse can grab any edge.
    if (edge === "move" ? !selected : !selected && event.pointerType !== "mouse") return;
    const options = {
      totalMs: total,
      snapMs,
      snapPoints: [0, ...starts, total, clock.get(), ...timeline.texts.filter((other) => other.id !== text.id).flatMap((other) => [other.startMs, other.endMs])],
    };
    const gesture = `drag:${text.id}:${Date.now()}`;
    startDrag(event, text.id, (delta) => onTextTiming(text.id, retimeText(text, edge, delta, options), gesture), {
      onStart: selected ? undefined : () => onGrab({ kind: "text", id: text.id }),
    });
  }

  function grabClip(event: React.PointerEvent<HTMLElement>, clip: Clip, index: number, edge: "start" | "end") {
    const element = scroller.current;
    if (!element) return;
    const start = starts[index];
    const length = clipDurationMs(clip);
    const sourceMs = library[clip.assetId]?.durationMs ?? undefined;
    const before = timeline;
    const startLeft = element.scrollLeft;
    const playhead = clock.get();
    const gesture = `drag:${clip.id}:${Date.now()}`;
    startDrag(
      event,
      clip.id,
      (delta) => {
        // The end edge sticks to the playhead, so "trim to here" is one drag.
        const d = edge === "end" ? snapTime(start + length + delta, [playhead], snapMs).ms - start - length : delta;
        const window = clipEdgeWindow(clip, edge, d);
        onClipTrim(clip.id, window, gesture);
        if (edge === "start") {
          // Cutting the opening pulls everything after the clip left. Scrolling
          // by the same amount keeps the rest of the reel still and lets the
          // clip's left edge follow the finger.
          const next = trimClip(before, clip.id, window, sourceMs);
          const shrunk = length - clipDurationMs(next.clips[index]);
          element.scrollLeft = startLeft - px(shrunk);
        }
      },
      { follow: edge === "end" },
    );
  }

  // Dragging the body of the selected clip reorders it; a marker shows where it lands.
  const [reorder, setReorder] = useState<{ id: string; dx: number; markerMs: number | null } | null>(null);
  function grabClipBody(event: React.PointerEvent<HTMLElement>, clip: Clip, index: number) {
    if (timeline.clips.length < 2) return;
    // Midpoints of the other clips where they sit now; passing one swaps places with it.
    const middles = timeline.clips.flatMap((other, i) => (i === index ? [] : [starts[i] + clipDurationMs(other) / 2]));
    const centre = starts[index] + clipDurationMs(clip) / 2;
    let target = index;
    startDrag(
      event,
      clip.id,
      (delta) => {
        target = middles.filter((middle) => middle < centre + delta).length;
        // The marker sits on the boundary in the current layout.
        const markerMs = target === index ? null : target < index ? starts[target] : (starts[target + 1] ?? total);
        setReorder({ id: clip.id, dx: px(delta), markerMs });
      },
      {
        onEnd: (moved) => {
          setReorder(null);
          if (moved && target !== index) onMoveClip(clip.id, target);
        },
      },
    );
  }

  // Texts that overlap in time go on separate rows, so every one can be reached.
  const textRows: number[] = [];
  const rowSpans: [number, number][][] = [];
  for (const text of timeline.texts) {
    let row = rowSpans.findIndex((spans) => spans.every(([from, to]) => text.endMs <= from || text.startMs >= to));
    if (row === -1) row = rowSpans.push([]) - 1;
    rowSpans[row].push([text.startMs, text.endMs]);
    textRows.push(row);
  }
  const textLaneRows = Math.max(1, rowSpans.length);

  const seconds = Math.ceil(total / 1000);
  // Label every second when there is room, otherwise every 5 or 10.
  const labelEvery = seconds <= 12 && pps >= 40 ? 1 : pps >= 90 ? 1 : pps >= 30 ? 5 : 10;
  const selectedId = selection && selection.kind !== "music" ? selection.id : null;
  const musicAsset = timeline.music ? library[timeline.music.assetId] : undefined;

  return (
    <div className="timeline">
      <div
        className="timeline-scroll"
        ref={scroller}
        onScroll={onScroll}
        data-testid="timeline"
        // Phones scroll the strip by touch. On a desktop the mouse wheel moves
        // it sideways (WheelScroll) and holding the button drags it, like a map.
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse" || event.button !== 0) return;
          const el = event.currentTarget;
          const startX = event.clientX;
          const startLeft = el.scrollLeft;
          let moved = false;
          const move = (e: PointerEvent) => {
            const dx = e.clientX - startX;
            if (Math.abs(dx) > 4) moved = true;
            if (moved) el.scrollLeft = startLeft - dx;
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (moved) el.dataset.dragged = "1";
            setTimeout(() => delete el.dataset.dragged, 0);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        onClickCapture={(event) => {
          // A drag that ends on a clip must not count as a tap on it.
          if (event.currentTarget.dataset.dragged) event.stopPropagation();
        }}
      >
        <div
          className="timeline-track"
          style={{ width: pad * 2 + totalPx + uploadsPx + 70, ["--pps" as string]: `${pps}px`, ["--pad" as string]: `${pad}px` }}
          onClick={(event) => {
            if (event.target === event.currentTarget) onSelect(null);
          }}
        >
          <div
            className="ruler"
            aria-hidden="true"
            style={{ marginLeft: pad, width: totalPx + 1 }}
            // Click the ruler to put the playhead there.
            onClick={(event) => onSeek(((event.clientX - event.currentTarget.getBoundingClientRect().left) * 1000) / pps)}
          >
            {Array.from({ length: seconds + 1 }, (_, second) => (
              <span key={second} style={{ left: px(second * 1000) }}>
                {second % labelEvery === 0 ? `${second}s` : ""}
              </span>
            ))}
          </div>

          <div className="lane lane-clips" role="list" aria-label="Clips">
            {timeline.clips.map((clip, index) => {
              const asset = library[clip.assetId];
              const duration = clipDurationMs(clip);
              const selected = selectedId === clip.id;
              return (
                <button
                  key={clip.id}
                  type="button"
                  role="listitem"
                  className="clip-block"
                  aria-pressed={selected}
                  aria-label={`Clip ${index + 1}, ${clip.pano ? "360 photo" : asset?.kind === "IMAGE" ? "photo" : "video"}, ${formatDuration(duration, true)}`}
                  data-testid="clip"
                  style={{
                    left: pad + px(starts[index]) + 1,
                    width: Math.max(8, px(duration) - 2),
                    backgroundImage: asset?.thumbUrl ? `url("${asset.thumbUrl}")` : undefined,
                    transform: reorder?.id === clip.id ? `translateX(${reorder.dx}px)` : undefined,
                  }}
                  data-dragging={dragging === clip.id || undefined}
                  data-lifted={reorder?.id === clip.id || undefined}
                  onPointerDown={(event) => selected && grabClipBody(event, clip, index)}
                  onClick={() => !suppressClick.current && onSelect(selected ? null : { kind: "clip", id: clip.id })}
                  onDoubleClick={() => onOpen({ kind: "clip", id: clip.id })}
                >
                  {selected ? (
                    <>
                      <span className="grip grip-start" aria-hidden="true" onPointerDown={(event) => grabClip(event, clip, index, "start")} />
                      <span className="grip grip-end" aria-hidden="true" onPointerDown={(event) => grabClip(event, clip, index, "end")} />
                    </>
                  ) : null}
                  {clip.transitionIn !== "cut" && index > 0 ? <span className="clip-fade" aria-hidden="true" /> : null}
                  <span className="clip-meta">
                    {clip.pano ? "360 " : ""}
                    {clip.kind === "VIDEO" && clip.speed !== 1 ? `${clip.speed}× ` : ""}
                    {formatDuration(duration, true)}
                  </span>
                </button>
              );
            })}
            {reorder?.markerMs != null ? <span className="drop-marker" style={{ left: pad + px(reorder.markerMs) - 2 }} /> : null}
            {timeline.clips.map((clip, index) =>
              dragging === clip.id && !reorder ? (
                <span key="badge" className="drag-badge" style={{ left: pad + px(starts[index] + clipDurationMs(clip) / 2), top: -24 }}>
                  {seconds1(clipDurationMs(clip))}
                </span>
              ) : null,
            )}
            {uploads.map((upload, index) => (
              <span
                key={upload.key}
                className="clip-block"
                data-uploading="true"
                title={upload.error ?? `Uploading ${upload.name}`}
                style={{
                  left: pad + totalPx + 4 + index * (UPLOAD_WIDTH + 4),
                  width: UPLOAD_WIDTH,
                  backgroundImage: upload.thumbUrl ? `url("${upload.thumbUrl}")` : undefined,
                }}
              >
                <span className="upload-progress" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
              </span>
            ))}
            <button
              type="button"
              className="lane-add"
              aria-label="Add photos or videos"
              style={{ left: pad + totalPx + uploadsPx + 8 }}
              onClick={onAddMedia}
            >
              <PlusIcon />
            </button>
          </div>

          <div className="lane" role="list" aria-label="Text overlays" style={{ height: textLaneRows * LANE_ROW }}>
            {timeline.texts.map((text, index) => {
              const selected = selectedId === text.id;
              return (
                <button
                  key={text.id}
                  type="button"
                  role="listitem"
                  className="bar bar-text"
                  aria-pressed={selected}
                  aria-label={`Text "${text.text}", ${formatDuration(text.startMs, true)} to ${formatDuration(text.endMs, true)}`}
                  data-testid="text-bar"
                  data-dragging={dragging === text.id || undefined}
                  style={{
                    left: pad + px(text.startMs),
                    width: Math.max(28, px(text.endMs - text.startMs)),
                    top: textRows[index] * LANE_ROW + 2,
                    bottom: "auto",
                    height: LANE_ROW - 4,
                  }}
                  onPointerDown={(event) => grabText(event, text, "move")}
                  onClick={() => !suppressClick.current && onSelect(selected ? null : { kind: "text", id: text.id })}
                  onDoubleClick={() => onOpen({ kind: "text", id: text.id })}
                >
                  <span className="grip grip-start" aria-hidden="true" onPointerDown={(event) => grabText(event, text, "start")} />
                  <TextIcon size={14} />
                  <span className="bar-label">{text.text}</span>
                  {selected && px(text.endMs - text.startMs) >= 110 ? <span className="bar-time">{seconds1(text.endMs - text.startMs)}</span> : null}
                  <span className="grip grip-end" aria-hidden="true" onPointerDown={(event) => grabText(event, text, "end")} />
                </button>
              );
            })}
            {timeline.texts.map((text, index) =>
              // A finger covers the bar, so while dragging its times show above it.
              dragging === text.id ? (
                <span key="badge" className="drag-badge" style={{ left: pad + px((text.startMs + text.endMs) / 2), top: textRows[index] * LANE_ROW - 22 }}>
                  {formatDuration(text.startMs, true)} · {seconds1(text.endMs - text.startMs)}
                </span>
              ) : null,
            )}
            {timeline.texts.length === 0 && timeline.clips.length > 0 ? (
              <button type="button" className="lane-hint" style={{ left: pad }} onClick={onAddText}>
                <TextIcon size={14} />
                Add text
              </button>
            ) : null}
          </div>

          <div className="lane" aria-label="Music track">
            {timeline.music ? (
              <button
                type="button"
                className="bar bar-music"
                aria-pressed={selection?.kind === "music"}
                style={{ left: pad, width: Math.max(40, totalPx) }}
                onClick={() => onSelect(selection?.kind === "music" ? null : { kind: "music" })}
              >
                <MusicIcon size={14} />
                {musicAsset?.fileName ?? "Music"}
              </button>
            ) : timeline.clips.length > 0 ? (
              <button type="button" className="lane-hint" style={{ left: pad }} onClick={onAddMusic}>
                <MusicIcon size={14} />
                Add music
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <span className="playhead" aria-hidden="true" />
      <div className="timeline-zoom" role="group" aria-label="Timeline zoom">
        <button type="button" aria-label="Zoom out" disabled={pps <= MIN_PPS} onClick={() => zoom(1 / 1.6)}>
          −
        </button>
        <button type="button" aria-label="Zoom in" disabled={pps >= MAX_PPS} onClick={() => zoom(1.6)}>
          +
        </button>
      </div>
    </div>
  );
}
