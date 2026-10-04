"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clipDurationMs, clipStartsMs, timelineDurationMs, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { formatDuration } from "@/lib/format";
import { MusicIcon, PlusIcon, TextIcon } from "../icons";
import type { Clock } from "./clock";

export type Selection = { kind: "clip"; id: string } | { kind: "text"; id: string } | { kind: "music" } | null;

export type PendingUpload = { key: string; name: string; progress: number; thumbUrl: string | null; error?: string };

/** Pixels per second of reel. */
export const PPS = 56;
const UPLOAD_WIDTH = 72;

type FilmstripProps = {
  timeline: Timeline;
  library: Record<string, LibraryAsset>;
  uploads: PendingUpload[];
  selection: Selection;
  clock: Clock;
  onSelect(selection: Selection): void;
  onScrub(ms: number): void;
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
  onScrub,
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

  const seconds = Math.ceil(total / 1000);
  const selectedId = selection && selection.kind !== "music" ? selection.id : null;
  const musicAsset = timeline.music ? library[timeline.music.assetId] : undefined;

  return (
    <div className="timeline">
      <div className="timeline-scroll" ref={scroller} onScroll={onScroll} data-testid="timeline">
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
                  onClick={() => onSelect(selected ? null : { kind: "clip", id: clip.id })}
                >
                  {clip.transitionIn === "fade" && index > 0 ? <span className="clip-fade" aria-hidden="true" /> : null}
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

          <div className="lane" role="list" aria-label="Text overlays">
            {timeline.texts.map((text) => (
              <button
                key={text.id}
                type="button"
                role="listitem"
                className="bar bar-text"
                aria-pressed={selectedId === text.id}
                data-testid="text-bar"
                style={{ left: pad + px(text.startMs), width: Math.max(24, px(text.endMs - text.startMs)) }}
                onClick={() => onSelect(selectedId === text.id ? null : { kind: "text", id: text.id })}
              >
                <TextIcon size={14} />
                {text.text}
              </button>
            ))}
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
