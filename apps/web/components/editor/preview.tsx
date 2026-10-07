"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { INSTAGRAM, REEL_FORMAT, textsAt, type TextOverlay, type Timeline } from "@reelwalk/core";
import { ReelComposition, reelDurationInFrames, textCss, type ReelAsset } from "@reelwalk/render/reel";
import { PlayIcon } from "../icons";
import { useClock, type Clock } from "./clock";

type PreviewProps = {
  timeline: Timeline;
  assets: Record<string, ReelAsset>;
  /** Called with the Player when it mounts and with null when it unmounts. */
  playerRef(player: PlayerRef | null): void;
  playing: boolean;
  guides: boolean;
  selectedText: TextOverlay | null;
  clock: Clock;
  onTogglePlay(): void;
  onMoveText(id: string, x: number, y: number, gesture: string): void;
  onResizeText(id: string, size: number, gesture: string): void;
  onSelectText(id: string): void;
  onEditText(id: string): void;
  empty: React.ReactNode;
};

/** Snaps to the centre line when the text is dragged close to it. */
function snap(value: number): number {
  return Math.abs(value - 0.5) < 0.02 ? 0.5 : value;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** An invisible copy of the text at preview scale, which gives a box the text's exact size. */
function Ghost({ text, scale }: { text: TextOverlay; scale: number }) {
  const css = textCss(text.style, text.color, text.size);
  return (
    <span style={{ display: "block", zoom: scale, width: REEL_FORMAT.width * 0.86, pointerEvents: "none" }}>
      <span style={{ ...css, display: "inline-block", color: "transparent", background: "transparent", textShadow: "none", WebkitTextStroke: "0" }}>
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
  scale,
  frame,
  onMove,
  onResize,
  onEdit,
}: {
  text: TextOverlay;
  scale: number;
  frame: RefObject<HTMLDivElement | null>;
  onMove(x: number, y: number, gesture: string): void;
  onResize(size: number, gesture: string): void;
  onEdit(): void;
}) {
  const grab = useRef<{ dx: number; dy: number; gesture: string } | null>(null);
  return (
    <button
      type="button"
      className="text-handle"
      aria-label={`Move text "${text.text}". Drag to place it, drag the corner to resize, double-click to edit.`}
      style={{ left: `${text.x * 100}%`, top: `${text.y * 100}%` }}
      onDoubleClick={onEdit}
      onPointerDown={(event) => {
        if (event.button !== 0 || !frame.current) return;
        const rect = frame.current.getBoundingClientRect();
        grab.current = {
          dx: (event.clientX - rect.left) / rect.width - text.x,
          dy: (event.clientY - rect.top) / rect.height - text.y,
          gesture: `drag:move-${text.id}:${Date.now()}`,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!grab.current || !event.currentTarget.hasPointerCapture(event.pointerId) || !frame.current) return;
        const rect = frame.current.getBoundingClientRect();
        const x = clamp((event.clientX - rect.left) / rect.width - grab.current.dx, 0.05, 0.95);
        const y = clamp((event.clientY - rect.top) / rect.height - grab.current.dy, 0.05, 0.95);
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
          onResize(clamp(Math.round((text.size + (event.key === "-" ? -0.1 : 0.1)) * 20) / 20, 0.5, 2.5), `size-${text.id}`);
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
            onResize(clamp(Math.round(((size * Math.hypot(e.clientX - cx, e.clientY - cy)) / from) * 20) / 20, 0.5, 2.5), gesture);
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
      {textsAt(timeline, now)
        .filter((text) => text.id !== selectedId)
        .map((text) => (
          <button
            key={text.id}
            type="button"
            className="text-hit"
            aria-label={`Select text "${text.text}"`}
            data-testid="text-target"
            style={{ left: `${text.x * 100}%`, top: `${text.y * 100}%` }}
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
  playerRef,
  playing,
  guides,
  selectedText,
  clock,
  onTogglePlay,
  onMoveText,
  onResizeText,
  onSelectText,
  onEditText,
  empty,
}: PreviewProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / REEL_FORMAT.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const hasClips = timeline.clips.length > 0;
  const zone = INSTAGRAM.safeZonePx;

  return (
    <div className="stage">
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
            <button
              type="button"
              className="stage-tap"
              aria-label={playing ? "Pause" : "Play"}
              onClick={onTogglePlay}
            />
            {!playing ? (
              <span className="play-badge">
                <PlayIcon size={30} />
              </span>
            ) : null}
          </>
        ) : (
          <div className="stage-empty">{empty}</div>
        )}

        {guides ? (
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

        {hasClips && !playing ? (
          <TextTargets clock={clock} timeline={timeline} selectedId={selectedText?.id ?? null} scale={scale} onSelect={onSelectText} onEdit={onEditText} />
        ) : null}
        {selectedText && !playing ? (
          <TextHandle
            text={selectedText}
            scale={scale}
            frame={frame}
            onMove={(x, y, gesture) => onMoveText(selectedText.id, x, y, gesture)}
            onResize={(size, gesture) => onResizeText(selectedText.id, size, gesture)}
            onEdit={() => onEditText(selectedText.id)}
          />
        ) : null}
      </div>
    </div>
  );
}
