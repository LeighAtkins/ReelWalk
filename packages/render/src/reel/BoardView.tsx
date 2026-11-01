import React from "react";
import { AbsoluteFill, Freeze, Html5Video, Img, Sequence, staticFile, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from "remotion";
import { Video as RenderVideo } from "@remotion/media";
import {
  boardColumnStarts,
  boardFrame,
  boardPanelAt,
  boardPanelEntryOpacity,
  boardPanelRects,
  isNamedEffect,
  type Board,
  type BoardPanel,
  type BoardRect,
} from "@reelwalk/core";
import { useFontsFor } from "./fonts";
import { TitleEffect } from "./toolbox/TitleEffect";
import type { ReelAsset } from "./types";

/**
 * The board (ADR 0106): a grid of silent video panels on a plain background, one column on screen at a time, every
 * panel of that column playing at once with its own label and title. Drawn over the clips and under the titles, from
 * the board's start (this component's frame 0) to its end. What moves when comes from `boardFrame` in core.
 */

const FACE = "'Archivo Variable', 'Noto Sans JP Variable', sans-serif";
const TYPE_CHARS_PER_S = 14;

function resolveSrc(src: string): string {
  return /^(https?:|blob:|data:)/.test(src) ? src : staticFile(src);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRect = (a: BoardRect, b: BoardRect, t: number): BoardRect => ({
  left: lerp(a.left, b.left, t),
  top: lerp(a.top, b.top, t),
  width: lerp(a.width, b.width, t),
  height: lerp(a.height, b.height, t),
});

/** A panel's footage: muted, cropped to the panel about its focus, playing from its start when its column comes in, held on its last frame. */
const PanelMedia: React.FC<{ panel: BoardPanel; asset: ReelAsset; fromFrame: number; durationInFrames: number; entryProgress?: number }> = ({ panel, asset, fromFrame, durationInFrames, entryProgress = 1 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  // Start the first panel at the opening shot's full-frame crop, then settle into its panel framing.
  const focusX = lerp(0.5, panel.focusX, entryProgress);
  const focusY = lerp(0.5, panel.focusY, entryProgress);
  const zoom = lerp(1, panel.zoom, entryProgress);
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: panel.fit,
    objectPosition: `${(focusX * 100).toFixed(2)}% ${(focusY * 100).toFixed(2)}%`,
    transformOrigin: `${(focusX * 100).toFixed(2)}% ${(focusY * 100).toFixed(2)}%`,
    transform: `scale(${zoom})`,
  };
  // The mirror flips the cropped picture about the panel's centre: flipped about the crop's focus instead, a zoomed
  // picture would slide out of the panel.
  const mirrored = (node: React.ReactNode) => (panel.mirror ? <div style={{ width: "100%", height: "100%", transform: "scaleX(-1)" }}>{node}</div> : node);
  const layers = panel.fit === "contain"
    ? [{ ...style, position: "absolute" as const, inset: 0, objectFit: "cover" as const, objectPosition: "50% 0%", filter: "blur(12px)", transform: "scale(1.08)" }, { ...style, position: "absolute" as const, inset: 0 }]
    : [style];
  if (asset.kind === "IMAGE") return <>{mirrored(layers.map((layer, i) => <Img key={i} src={resolveSrc(asset.src)} style={layer} />))}</>;
  const startFrame = Math.round((panel.sourceStartMs * fps) / 1000);
  // Past the end of the file the last frame holds: the column may stay on screen longer than the footage runs.
  const lastFrame = asset.durationMs ? Math.max(0, Math.floor((asset.durationMs * fps) / 1000) - startFrame - 1) : Infinity;
  const local = frame - fromFrame;
  const held = local > lastFrame ? lastFrame : null;
  const timing = { src: resolveSrc(asset.src), trimBefore: startFrame, muted: true, volume: 0 };
  return (
    <>
      {mirrored(
        <Freeze frame={(held ?? 0) + fromFrame} active={held !== null}>
          <Sequence from={fromFrame} durationInFrames={durationInFrames} layout="none" name={`panel ${panel.id}`}>
            {layers.map((layer, i) => isRendering
              ? <RenderVideo key={i} {...timing} objectFit={i === 0 ? "cover" : "contain"} style={{ ...layer, objectFit: undefined }} />
              : <Html5Video key={i} {...timing} style={layer} />)}
          </Sequence>
        </Freeze>,
      )}
    </>
  );
};

/** A panel's words: the lead line in the board's text colour and the keyword in its accent, arriving with its effect. */
const PanelTitle: React.FC<{ board: Board; panel: BoardPanel; rect: BoardRect; titleMs: number; lifeMs: number }> = ({ board, panel, rect, titleMs, lifeMs }) => {
  const title = panel.title;
  if (!title) return null;
  const fontSize = rect.height * 0.2;
  const shadow = `0 ${(fontSize * 0.04).toFixed(1)}px ${(fontSize * 0.12).toFixed(1)}px rgba(0,0,0,0.38)`;
  const lead: React.CSSProperties = { fontFamily: FACE, fontWeight: 420, fontSize, lineHeight: 1.02, color: board.textColor, textShadow: shadow, whiteSpace: "pre-line", textAlign: "center" };
  const key: React.CSSProperties = { fontFamily: FACE, fontWeight: 800, fontSize, lineHeight: 1.02, color: board.keywordColor, textShadow: shadow, whiteSpace: "nowrap" };
  const centre = title.side === "left" ? 0.2 : 0.8;
  let keyword: React.ReactNode = null;
  if (titleMs >= 0) {
    if (isNamedEffect(title.effect)) {
      keyword = <TitleEffect effect={title.effect} text={title.keyword} face={key} color={board.keywordColor} fontSize={fontSize} boxWidth={fontSize * 0.56 * title.keyword.length} heightEm={1.02} titleMs={titleMs} lifeMs={Math.max(lifeMs, titleMs + 1)} />;
    } else if (title.effect === "type") {
      const chars = Math.min(title.keyword.length, Math.floor((titleMs / 1000) * TYPE_CHARS_PER_S));
      const typing = chars < title.keyword.length && Math.floor(titleMs / 250) % 2 === 0;
      keyword = (
        <span style={{ ...key, position: "relative", display: "inline-block" }}>
          <span style={{ visibility: "hidden" }}>{title.keyword}</span>
          <span style={{ position: "absolute", left: 0, top: 0 }}>{title.keyword.slice(0, chars)}{typing ? "|" : ""}</span>
        </span>
      );
    } else {
      const opacity = title.effect === "fadeQuick" ? Math.min(1, titleMs / 200) : 1;
      keyword = <span style={{ ...key, opacity }}>{title.keyword}</span>;
    }
  }
  return (
    <div style={{ position: "absolute", left: rect.width * centre, top: rect.height / 2, transform: "translate(-50%, -50%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
      {title.lead ? <span style={lead}>{title.lead}</span> : null}
      {/* The keyword's line keeps its height before it arrives, so the lead never jumps. */}
      <span style={{ ...key, position: "relative", minHeight: fontSize * 1.02 }}>{keyword}</span>
    </div>
  );
};

/** The Instagram glyph, white, with the brand gradient pulsing into it (the reference's social outro). */
const Glyph: React.FC<{ size: number; pulse: number }> = ({ size, pulse }) => {
  const stroke = size * 0.085;
  const shape = (color: string) => (
    <>
      <rect x={stroke / 2} y={stroke / 2} width={size - stroke} height={size - stroke} rx={size * 0.28} fill="none" stroke={color} strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={size * 0.22} fill="none" stroke={color} strokeWidth={stroke} />
      <circle cx={size * 0.76} cy={size * 0.24} r={size * 0.055} fill={color} />
    </>
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible", filter: `drop-shadow(0 ${size * 0.03}px ${size * 0.08}px rgba(0,0,0,0.35))` }}>
      <defs>
        <linearGradient id="rw-board-glyph" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#feda75" />
          <stop offset="0.3" stopColor="#fa7e1e" />
          <stop offset="0.6" stopColor="#d62976" />
          <stop offset="0.85" stopColor="#962fbf" />
          <stop offset="1" stopColor="#4f5bd5" />
        </linearGradient>
      </defs>
      <g>{shape("#ffffff")}</g>
      <g opacity={pulse}>{shape("url(#rw-board-glyph)")}</g>
    </svg>
  );
};

export const BoardView: React.FC<{ board: Board; assets: Record<string, ReelAsset> }> = ({ board, assets }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const words = board.panels.flatMap((panel) => [panel.label, panel.title?.lead ?? "", panel.title?.keyword ?? ""]).join(" ") + (board.outro?.handle ?? "");
  useFontsFor(words, 800);
  const reelMs = board.startMs + (frame * 1000) / fps;
  const f = boardFrame(board, reelMs);
  const starts = boardColumnStarts(board);
  const rects = boardPanelRects(board.rows, width, height);
  const scale = width / 1080;
  const radius = board.radius * scale;
  const toFrame = (ms: number) => Math.round(((ms - board.startMs) * fps) / 1000);
  const boardFrames = toFrame(board.endMs);
  const labelSize = height * 0.0125;

  // Only the columns on screen, or sliding in or out, are drawn (and only their footage decoded).
  const columns = Array.from({ length: board.columns }, (_, column) => column).filter((column) => Math.abs(column - f.scroll) < 1);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ backgroundColor: board.background, opacity: f.backdrop }} />
      {columns.map((column) => {
        const columnStart = starts[column];
        const columnEnd = starts[column + 1] ?? board.endMs;
        // The footage plays from its column's arrival (the slide eases in from that moment) to the board's end.
        const mediaFrom = Math.max(0, toFrame(columnStart));
        return (
          <div key={column} style={{ position: "absolute", left: (column - f.scroll) * width, top: 0, width, height }}>
            {Array.from({ length: board.rows }, (_, row) => {
              const panel = boardPanelAt(board, column, row);
              if (!panel) return null;
              const asset = assets[panel.assetId];
              const entering = column === 0 && row === 0 && f.entry < 1;
              const rect = entering ? lerpRect({ left: 0, top: 0, width, height }, rects[row], f.entry) : rects[row];
              const opacity = boardPanelEntryOpacity(board, column, row, reelMs);
              const keywordAt = columnStart + (column === 0 ? board.entryMs : 0) + (panel.title?.delayMs ?? 0);
              return (
                <React.Fragment key={panel.id}>
                  {panel.label ? (
                    <div style={{ position: "absolute", left: rects[row].left + radius * 0.25, top: rects[row].top - labelSize * 1.55, fontFamily: FACE, fontWeight: 500, fontSize: labelSize, color: board.labelColor, opacity: opacity * (column === 0 && row === 0 ? f.entry : 1), whiteSpace: "nowrap" }}>
                      {panel.label}
                    </div>
                  ) : null}
                  <div style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderRadius: entering ? radius * f.entry : radius, overflow: "hidden", opacity, backgroundColor: "#1d1b19", boxShadow: `0 ${8 * scale}px ${22 * scale}px rgba(0,0,0,${(0.2 * (entering ? f.entry : 1)).toFixed(3)})` }}>
                    {asset ? <PanelMedia panel={panel} asset={asset} fromFrame={mediaFrom} durationInFrames={Math.max(1, boardFrames - mediaFrom)} entryProgress={entering ? f.entry : 1} /> : null}
                    {/* The shrinking first panel carries no words until it has landed: they belong to the panel, not the full frame. */}
                    {entering ? null : <PanelTitle board={board} panel={panel} rect={rects[row]} titleMs={reelMs - keywordAt} lifeMs={columnEnd - keywordAt + board.slideMs} />}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        );
      })}
      {f.brightness < 1 ? <AbsoluteFill style={{ backgroundColor: "#000", opacity: 1 - f.brightness }} /> : null}
      {board.outro && reelMs >= board.outro.atMs ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: `translateY(${-height * 0.06}px)` }}>
            {board.outro.glyph === "instagram" ? (
              <div style={{ transform: `scale(${f.glyph})`, opacity: Math.min(1, f.glyph * 1.5) }}>
                <Glyph size={width * 0.105} pulse={f.pulse} />
              </div>
            ) : null}
            <div style={{ marginTop: height * 0.022, fontFamily: FACE, fontWeight: 650, fontStretch: "75%", letterSpacing: "0.02em", fontSize: width * 0.03, color: "#ffffff", opacity: f.handle, textTransform: "uppercase", textShadow: "0 2px 8px rgba(0,0,0,0.45)" }}>
              {board.outro.handle}
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
