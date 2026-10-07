"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

/** Pixels per second of reel. */
export const PPS = 56;
const UPLOAD_WIDTH = 72;
/** How close, in pixels, a dragged edge has to come to a cut or the playhead to stick to it. */
const SNAP_PX = 8;
const LANE_ROW = 28;

type FilmstripProps = {
  timeline: Timeline;
  library: Record<string, LibraryAsset>;
  uploads: PendingUpload[];
  selection: Selection;
  clock: Clock;
  onSelect(selection: Selection): void;
  /** Select without moving the playhead, for a drag that starts on an unselected item. */
  onGrab(selection: Selection): void;
  onScrub(ms: number): void;
  /** One call per pointer move; calls with the same gesture make one undo step. */
  onTextTiming(id: string, timing: { startMs: number; endMs: number }, gesture: string): void;
  onClipTrim(id: string, window: { sourceStartMs: number; sourceEndMs: number }, gesture: string): void;
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
  onGrab,
  onScrub,
  onTextTiming,
  onClipTrim,
  onAddMedia,
  onAddText,
  onAddMusic,
}: FilmstripProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState(180);
  const programmatic = useRef<number | null>(null);

  const total = timelineDurationMs(timeline);
  const starts = clipStartsMs(timeline);
  const px = (ms: number) => (ms * PPS) / 1000;
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
      const left = Math.round(px(ms));
      if (Math.abs(element.scrollLeft - left) < 1) return;
      programmatic.current = left;
      element.scrollLeft = left;
    };
    apply(clock.get());
    return clock.subscribe((ms, source) => {
      if (source !== "scrub") apply(ms);
    });
  }, [clock]);

  // Scroll position -> playhead, when the user drags the strip.
  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    if (programmatic.current !== null && Math.abs(element.scrollLeft - programmatic.current) <= 1) {
      programmatic.current = null;
      return;
    }
    programmatic.current = null;
    onScrub(Math.min(total, Math.max(0, (element.scrollLeft * 1000) / PPS)));
  }

  // ── Dragging edges ──────────────────────────────────────────
  const [dragging, setDragging] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const snapMs = (SNAP_PX * 1000) / PPS;

  /**
   * Follow a pointer from a grip until it is released. onMove gets the
   * distance in reel milliseconds. With follow on, the strip scrolls by itself
   * when the pointer nears either side, and that scroll counts as distance.
   */
  function startDrag(
    event: React.PointerEvent<HTMLElement>,
    id: string,
    onMove: (deltaMs: number) => void,
    { follow = true, onStart }: { follow?: boolean; onStart?: () => void } = {},
  ) {
    const element = scroller.current;
    if (!element || event.button !== 0) return;
    event.stopPropagation();
    const startX = event.clientX;
    const startLeft = element.scrollLeft;
    let pointerX = startX;
    let moved = false;
    let frame = 0;
    const update = () => onMove(((pointerX - startX + (follow ? element.scrollLeft - startLeft : 0)) * 1000) / PPS);
    const edgeScroll = () => {
      const box = element.getBoundingClientRect();
      const step = pointerX < box.left + 40 ? -6 : pointerX > box.right - 40 ? 6 : 0;
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
        // it sideways and holding the button drags it, like a map.
        onWheel={(event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
        }}
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
          style={{ width: pad * 2 + totalPx + uploadsPx + 70, ["--pps" as string]: `${PPS}px`, ["--pad" as string]: `${pad}px` }}
          onClick={(event) => {
            if (event.target === event.currentTarget) onSelect(null);
          }}
        >
          <div className="ruler" aria-hidden="true" style={{ marginLeft: pad, width: totalPx + 1 }}>
            {Array.from({ length: seconds + 1 }, (_, second) => (
              <span key={second} style={{ left: px(second * 1000) }}>
                {second % 5 === 0 || seconds <= 12 ? `${second}s` : ""}
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
                  }}
                  data-dragging={dragging === clip.id || undefined}
                  onClick={() => !suppressClick.current && onSelect(selected ? null : { kind: "clip", id: clip.id })}
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
                >
                  <span className="grip grip-start" aria-hidden="true" onPointerDown={(event) => grabText(event, text, "start")} />
                  <TextIcon size={14} />
                  <span className="bar-label">{text.text}</span>
                  {selected ? <span className="bar-time">{((text.endMs - text.startMs) / 1000).toFixed(1)}s</span> : null}
                  <span className="grip grip-end" aria-hidden="true" onPointerDown={(event) => grabText(event, text, "end")} />
                </button>
              );
            })}
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
    </div>
  );
}
