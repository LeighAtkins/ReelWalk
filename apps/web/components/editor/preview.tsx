"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { prefetch } from "remotion";
import { INSTAGRAM, minTextSize, oneLineWidth, pinnedProgress, PLANAR_MAX_WIDTH, planarFitAndShift, REEL_FORMAT, TEXT_SIZE_MAX, textsAt, textPositionAt, textQuadAt, type TextOverlay, type Timeline } from "@reelwalk/core";
import { ReelComposition, reelDurationInFrames, textTreatmentCss, type ReelAsset } from "@reelwalk/render/reel";
import { PlayIcon } from "../icons";
import { useClock, type Clock } from "./clock";

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
  onSelectText(id: string): void;
  onEditText(id: string): void;
  empty: React.ReactNode;
  /** Full-screen viewing: the frame fills the screen, editing handles hide. */
  theater?: boolean;
  onExitTheater?(): void;
  /** Check mode (ADR 0044): full screen with a strip of moments to jump to, every title's surface outlined. */
  check?: { marks: { label: string; ms: number }[]; onSeek(ms: number): void } | null;
  /** Corner placing (ADR 0044): full screen, only the selected title's corners and posts, a loupe under the finger. */
  corners?: boolean;
  onDoneCorners?(): void;
};

/** Snaps to the centre line when the text is dragged close to it. */
function snap(value: number): number {
  return Math.abs(value - 0.5) < 0.02 ? 0.5 : value;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Drags a point in frame fractions, calling `onMove` with the pointer's position inside the frame while the pointer is down. */
function dragPoint(event: React.PointerEvent<HTMLButtonElement>, frame: RefObject<HTMLDivElement | null>, onMove: (x: number, y: number) => void, onEnd?: () => void) {
  if (event.button !== 0 || !frame.current) return;
  event.stopPropagation();
  event.currentTarget.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    const rect = frame.current!.getBoundingClientRect();
    onMove(Math.max(-0.5, Math.min(1.5, (e.clientX - rect.left) / rect.width)), Math.max(-0.5, Math.min(1.5, (e.clientY - rect.top) / rect.height)));
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onEnd?.(); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

const quadPoints = (quad: readonly number[]) => `${quad[0] * 100},${quad[1] * 100} ${quad[2] * 100},${quad[3] * 100} ${quad[4] * 100},${quad[5] * 100} ${quad[6] * 100},${quad[7] * 100}`;

/** The <video> the stage is showing now: the one with a picture and a size on screen. */
function visibleVideo(frame: HTMLElement): HTMLVideoElement | null {
  for (const video of Array.from(frame.querySelectorAll("video"))) {
    if (video.videoWidth > 0 && video.readyState >= 2 && video.getBoundingClientRect().width > 0) return video;
  }
  return null;
}

const LOUPE_SIZE = 150, LOUPE_ZOOM = 2.5;

/**
 * A magnifier above the finger while a corner is dragged (ADR 0044): the
 * footage around the point at two and a half times, with a cross-hair, so a
 * corner can be put on a wall's edge on a phone. Draws straight from the
 * stage's <video> through the same cover geometry the picture is shown with.
 */
function Loupe({ frame, x, y }: { frame: RefObject<HTMLDivElement | null>; x: number; y: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const stage = frame.current, out = canvas.current;
    if (!stage || !out) return;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    const video = visibleVideo(stage);
    const rect = stage.getBoundingClientRect();
    if (video && rect.width > 0) {
      // object-fit: cover; the picture is scaled to fill the frame and centred.
      const scale = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
      const ox = (rect.width - video.videoWidth * scale) / 2, oy = (rect.height - video.videoHeight * scale) / 2;
      const px = (x * rect.width - ox) / scale, py = (y * rect.height - oy) / scale;
      const span = LOUPE_SIZE / LOUPE_ZOOM / scale;
      try { ctx.drawImage(video, px - span / 2, py - span / 2, span, span, 0, 0, LOUPE_SIZE, LOUPE_SIZE); } catch { /* a frame mid-decode: the black stays */ }
    }
    ctx.strokeStyle = "rgba(255,90,95,0.95)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(LOUPE_SIZE / 2, 0); ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE); ctx.moveTo(0, LOUPE_SIZE / 2); ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2); ctx.stroke();
  }, [frame, x, y]);
  // Above the finger, kept inside the frame; below it near the top edge.
  const above = y > 0.22;
  return (
    <canvas ref={canvas} className="loupe" width={LOUPE_SIZE} height={LOUPE_SIZE} aria-hidden="true"
      style={{ left: `calc(${Math.min(0.999, Math.max(0.001, x)) * 100}% - ${LOUPE_SIZE / 2}px)`, top: above ? `calc(${y * 100}% - ${LOUPE_SIZE + 48}px)` : `calc(${y * 100}% + 48px)` }} />
  );
}

/**
 * The surface a title is painted on: a dashed outline with a numbered,
 * draggable corner at each of its four points, set by hand on the first
 * frame of the shot (ADR 0043, ADR 0044). While a corner is dragged, a
 * cross-hair through it helps land it on the wall's edge. Posts in front of
 * the surface (a mullion, a pole) are strips whose two edges drag sideways.
 */
function SurfaceHandles({ quad, bars = [], frame, onChange, onBars, large = false }: { quad: number[]; bars?: number[][]; frame: RefObject<HTMLDivElement | null>; onChange(quad: number[], gesture: string): void; onBars?(bars: number[][], gesture: string): void; large?: boolean }) {
  const [active, setActive] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      {large && active ? <Loupe frame={frame} x={active.x} y={active.y} /> : null}
      <svg className="surface-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        <polygon points={quadPoints(quad)} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.85)" strokeWidth={0.4} strokeDasharray="1.2 0.8" vectorEffect="non-scaling-stroke" />
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
              const next = [...quad]; next[i * 2] = x; next[i * 2 + 1] = y;
              setActive({ x, y });
              onChange(next.map((v) => Number(v.toFixed(4))), gesture);
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
                    const next = bars.map((q) => [...q]);
                    next[b][top] = x; next[b][bottom] = x;
                    setActive({ x, y });
                    onBars(next.map((q) => q.map((v) => Number(v.toFixed(4)))), gesture);
                  }, () => setActive(null));
                }} />
            );
          })}
          <button type="button" className="surface-bar-remove" aria-label={`Remove post ${b + 1}`} style={{ left: `${((bar[0] + bar[2]) / 2) * 100}%`, top: `${Math.min(bar[1], bar[3]) * 100}%` }}
            onPointerDown={(event) => event.stopPropagation()} onClick={() => onBars(bars.filter((_, i) => i !== b), `bar-remove-${Date.now()}`)}>×</button>
        </span>
      )) : null}
    </>
  );
}

/** Check mode: every title on screen now, its surface (tracked where it is pinned) outlined, so a drift or a miss shows at full size before an export (ADR 0044). */
function SurfaceOutlines({ clock, timeline }: { clock: Clock; timeline: Timeline }) {
  const now = useClock(clock);
  const shapes = textsAt(timeline, now).flatMap((text) => {
    const quad = text.pin ? textQuadAt(text, pinnedProgress(timeline, text, now)) : null;
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
      <span style={{ ...css, display: "inline-block", color: "transparent", background: "transparent", textShadow: "none", WebkitTextStroke: "0", ...(text.pin ? { whiteSpace: "nowrap", transform: `scale(${text.pin.quad ? planarFitAndShift(text.pin.quad, oneLineWidth(text.text, { fontFamily: String(css.fontFamily ?? ""), fontWeight: css.fontWeight, fontSize: Number(css.fontSize) || 64, letterSpacing: text.tracking, fontStretch: css.fontStretch ? String(css.fontStretch) : undefined })).fit : 1})`, transformOrigin: "0 0" } : {}) }}>
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
          onResize(clamp(Math.round((text.size + (event.key === "-" ? -0.1 : 0.1)) * 20) / 20, minTextSize(text.style), TEXT_SIZE_MAX), `size-${text.id}`);
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
            onResize(clamp(Math.round(((size * Math.hypot(e.clientX - cx, e.clientY - cy)) / from) * 20) / 20, minTextSize(text.style), TEXT_SIZE_MAX), gesture);
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
  onSelectText,
  onEditText,
  empty,
  theater = false,
  onExitTheater,
  check = null,
  corners = false,
  onDoneCorners,
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

  return (
    <div className={theater ? "stage stage-theater" : "stage"} ref={stage}>
      {theater && corners ? (
        <div className="corners-bar" data-testid="corners-bar">
          <span className="small">Drag each numbered corner onto the surface's corner. The loupe shows the picture under your finger.</span>
          <button type="button" className="btn btn-signal" onClick={() => onDoneCorners?.()} data-testid="corners-done">Done</button>
        </div>
      ) : theater ? (
        <button type="button" className="theater-close" aria-label="Exit full screen" onClick={() => onExitTheater?.()} data-testid="preview-fullscreen-close">
          ×
        </button>
      ) : null}
      {theater && check ? <CheckStrip clock={clock} marks={check.marks} onSeek={check.onSeek} /> : null}
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
            {theater && corners ? null : (
              <button
                type="button"
                className="stage-tap"
                aria-label={playing ? "Pause" : "Play"}
                onClick={onTogglePlay}
              />
            )}
            {!playing && !(theater && corners) ? (
              <span className="play-badge">
                <PlayIcon size={30} />
              </span>
            ) : null}
          </>
        ) : (
          <div className="stage-empty">{empty}</div>
        )}

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
          <SurfaceHandles large quad={selectedText.surface} bars={selectedText.bars} frame={frame} onChange={(quad, gesture) => onSurfaceText(selectedText.id, quad, gesture)} onBars={onBarsText ? (bars, gesture) => onBarsText(selectedText.id, bars, gesture) : undefined} />
        ) : null}
        {selectedText && !playing && !theater ? (<>
          <TextHandle
            text={selectedText}
            clock={clock}
            scale={scale}
            frame={frame}
            onMove={(x, y, gesture) => onMoveText(selectedText.id, x, y, gesture)}
            onResize={(size, gesture) => onResizeText(selectedText.id, size, gesture)}
            onEdit={() => onEditText(selectedText.id)}
          />
          {selectedText.surface && onSurfaceText ? (
            <SurfaceHandles quad={selectedText.surface} bars={selectedText.bars} frame={frame} onChange={(quad, gesture) => onSurfaceText(selectedText.id, quad, gesture)} onBars={onBarsText ? (bars, gesture) => onBarsText(selectedText.id, bars, gesture) : undefined} />
          ) : null}
        </>) : null}
        {theater && check ? <SurfaceOutlines clock={clock} timeline={timeline} /> : null}
      </div>
    </div>
  );
}
