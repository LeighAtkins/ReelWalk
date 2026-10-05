"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { INSTAGRAM, REEL_FORMAT, type TextOverlay, type Timeline } from "@reelwalk/core";
import { ReelComposition, reelDurationInFrames, textCss, type ReelAsset } from "@reelwalk/render/reel";
import { PlayIcon } from "../icons";

type PreviewProps = {
  timeline: Timeline;
  assets: Record<string, ReelAsset>;
  /** Called with the Player when it mounts and with null when it unmounts. */
  playerRef(player: PlayerRef | null): void;
  playing: boolean;
  guides: boolean;
  selectedText: TextOverlay | null;
  onTogglePlay(): void;
  onMoveText(id: string, x: number, y: number): void;
  empty: React.ReactNode;
};

/** Snaps to the centre line when the text is dragged close to it. */
function snap(value: number): number {
  return Math.abs(value - 0.5) < 0.02 ? 0.5 : value;
}

function TextHandle({
  text,
  scale,
  frame,
  onMove,
}: {
  text: TextOverlay;
  scale: number;
  frame: RefObject<HTMLDivElement | null>;
  onMove(x: number, y: number): void;
}) {
  const css = textCss(text.style, text.color, text.size);
  return (
    <button
      type="button"
      className="text-handle"
      aria-label={`Move text "${text.text}". Drag to place it.`}
      style={{ left: `${text.x * 100}%`, top: `${text.y * 100}%` }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || !frame.current) return;
        const rect = frame.current.getBoundingClientRect();
        const x = Math.min(0.95, Math.max(0.05, (event.clientX - rect.left) / rect.width));
        const y = Math.min(0.95, Math.max(0.05, (event.clientY - rect.top) / rect.height));
        onMove(snap(x), y);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 0.05 : 0.01;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        onMove(Math.min(0.95, Math.max(0.05, text.x + move[0])), Math.min(0.95, Math.max(0.05, text.y + move[1])));
      }}
    >
      {/* An invisible copy of the text, at preview scale, gives the handle the text's exact size. */}
      <span style={{ display: "block", zoom: scale, width: REEL_FORMAT.width * 0.86, pointerEvents: "none" }}>
        <span
          style={{
            ...css,
            display: "inline-block",
            color: "transparent",
            background: "transparent",
            textShadow: "none",
            WebkitTextStroke: "0",
          }}
        >
          {text.text}
        </span>
      </span>
    </button>
  );
}

export function Preview({
  timeline,
  assets,
  playerRef,
  playing,
  guides,
  selectedText,
  onTogglePlay,
  onMoveText,
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

        {selectedText && !playing ? (
          <TextHandle text={selectedText} scale={scale} frame={frame} onMove={(x, y) => onMoveText(selectedText.id, x, y)} />
        ) : null}
      </div>
    </div>
  );
}
