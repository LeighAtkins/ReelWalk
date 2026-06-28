import React, { useCallback, useRef } from "react";
import { useEditorStore } from "../store";
import type { Clip } from "../types";

const FRAME_PX = 5; // pixels per frame
const CLIP_HEIGHT = 52;
const TRACK_PADDING = 4;

export const Timeline: React.FC = () => {
  const project = useEditorStore((s) => s.project);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const totalDuration = useEditorStore((s) => s.totalDuration);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);
  const selectClip = useEditorStore((s) => s.selectClip);
  const dragClip = useEditorStore((s) => s.dragClip);
  const trimClip = useEditorStore((s) => s.trimClip);
  const removeClip = useEditorStore((s) => s.removeClip);
  const splitClipAtPlayhead = useEditorStore((s) => s.splitClipAtPlayhead);
  const toggleTrackVisibility = useEditorStore((s) => s.toggleTrackVisibility);
  const removeTrack = useEditorStore((s) => s.removeTrack);
  const addTrack = useEditorStore((s) => s.addTrack);
  const tracksRef = useRef<HTMLDivElement>(null);

  // Click on empty timeline area — move playhead
  const handleRulerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const rect = tracksRef.current?.getBoundingClientRect();
      if (!rect) return;
      const scrollLeft = tracksRef.current?.scrollLeft ?? 0;
      const x = e.clientX - rect.left + scrollLeft;
      setCurrentFrame(Math.max(0, Math.round(x / FRAME_PX)));

      // Enable drag-to-scrub on ruler
      const onMove = (ev: MouseEvent) => {
        const r = tracksRef.current?.getBoundingClientRect();
        if (!r) return;
        const sl = tracksRef.current?.scrollLeft ?? 0;
        const dx = ev.clientX - r.left + sl;
        setCurrentFrame(Math.max(0, Math.round(dx / FRAME_PX)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [setCurrentFrame]
  );

  // Drag a clip horizontally
  const handleClipMouseDown = useCallback(
    (e: React.MouseEvent, clip: Clip) => {
      e.stopPropagation();
      selectClip(clip.id);

      const startX = e.clientX;
      const startFrame = clip.startFrame;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const frameDelta = Math.round(dx / FRAME_PX);
        dragClip(clip.id, startFrame + frameDelta);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [selectClip, dragClip]
  );

  // Trim a clip edge
  const handleTrimMouseDown = useCallback(
    (e: React.MouseEvent, clip: Clip, fromStart: boolean) => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startDur = clip.durationFrames;
      const startStart = clip.startFrame;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const frameDelta = Math.round(dx / FRAME_PX);
        if (fromStart) {
          const newDur = startDur - frameDelta;
          trimClip(clip.id, newDur, true);
        } else {
          trimClip(clip.id, startDur + frameDelta, false);
        }
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [trimClip]
  );

  const timelineWidth = Math.max(totalDuration * FRAME_PX + 200, 800);
  const selectedClip = project.tracks
    .flatMap((t) => t.clips)
    .find((c) => c.id === selectedClipId);

  return (
    <div className="timeline-panel">
      {/* Track headers column + ruler */}
      <div className="timeline-header-row">
        <div className="track-headers-col">
          <div className="ruler-spacer" />
          {project.tracks.map((track) => (
            <div key={track.id} className="track-header" style={{ height: CLIP_HEIGHT + TRACK_PADDING * 2 }}>
              <span
                className="vis-toggle"
                onClick={() => toggleTrackVisibility(track.id)}
              >
                {track.visible ? "👁" : "🚫"}
              </span>
              <div className="track-info">
                <span className="track-name">{track.name}</span>
                <span className="track-type">{track.type === "pano" ? "360°" : track.type}</span>
              </div>
              <button
                className="track-delete"
                onClick={() => removeTrack(track.id)}
                title="Delete track"
              >
                ✕
              </button>
            </div>
          ))}
          <button className="add-track-btn" onClick={() => addTrack("video")}>
            + Track
          </button>
        </div>

        {/* Scrollable timeline area */}
        <div className="timeline-scroll" ref={tracksRef}>
          {/* Ruler */}
          <div
            className="ruler"
            style={{ width: timelineWidth }}
            onMouseDown={handleRulerMouseDown}
          >
            {Array.from({ length: Math.ceil(timelineWidth / (FRAME_PX * 30)) + 1 }, (_, i) => (
              <div
                key={i}
                className="ruler-tick"
                style={{ left: i * 30 * FRAME_PX }}
              >
                <span>{i}s</span>
              </div>
            ))}
          </div>

          {/* Tracks */}
          {project.tracks.map((track) => (
            <div
              key={track.id}
              className="track-lane"
              style={{
                width: timelineWidth,
                height: CLIP_HEIGHT + TRACK_PADDING * 2,
              }}
            >
              {track.visible && track.clips.map((clip) => {
                const left = clip.startFrame * FRAME_PX;
                const width = Math.max(clip.durationFrames * FRAME_PX, 20);
                const isSelected = clip.id === selectedClipId;

                return (
                  <div
                    key={clip.id}
                    className={`clip ${clip.type} ${isSelected ? "selected" : ""}`}
                    style={{ left, width, top: TRACK_PADDING, height: CLIP_HEIGHT }}
                    onMouseDown={(e) => handleClipMouseDown(e, clip)}
                  >
                    {/* Left trim handle */}
                    <div
                      className="trim-handle left"
                      onMouseDown={(e) => handleTrimMouseDown(e, clip, true)}
                    />
                    {/* Clip thumbnail / label */}
                    {clip.type === "video" && (
                      <div className="clip-thumb">🎬</div>
                    )}
                    {clip.type === "pano" && (
                      <div className="clip-thumb">🌐</div>
                    )}
                    {clip.type === "image" && (
                      <div className="clip-thumb">🖼</div>
                    )}
                    {clip.type === "text" && (
                      <div className="clip-thumb">✏️</div>
                    )}
                    {clip.type === "audio" && (
                      <div className="clip-thumb">🎵</div>
                    )}
                    <span className="clip-name">{clip.name}</span>
                    <span className="clip-dur">
                      {(clip.durationFrames / project.fps).toFixed(1)}s
                    </span>
                    {/* Right trim handle */}
                    <div
                      className="trim-handle right"
                      onMouseDown={(e) => handleTrimMouseDown(e, clip, false)}
                    />
                  </div>
                );
              })}
            </div>
          ))}

          {/* Playhead */}
          <div
            className="playhead"
            style={{ left: currentFrame * FRAME_PX }}
          />
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="timeline-toolbar">
        {selectedClip ? (
          <>
            <span className="clip-info">
              {selectedClip.name} · {(selectedClip.durationFrames / project.fps).toFixed(1)}s · frame {selectedClip.startFrame}
            </span>
            <button
              className="btn"
              onClick={() => splitClipAtPlayhead(selectedClip.id)}
              title="Split at playhead"
            >
              ✂️ Split
            </button>
            <button
              className="btn btn-danger"
              onClick={() => removeClip(selectedClip.id)}
            >
              🗑 Delete
            </button>
          </>
        ) : (
          <span className="hint">Select a clip to edit · Click ruler to move playhead</span>
        )}
      </div>

      <style>{`
        .timeline-panel {
          display: flex;
          flex-direction: column;
          background: #12121f;
          border-top: 1px solid #2a2a4a;
          height: 280px;
          min-height: 280px;
          flex-shrink: 0;
        }
        .timeline-header-row {
          display: flex;
          flex: 1;
          min-height: 0;
        }
        .track-headers-col {
          width: 160px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          background: #0d0d1a;
          border-right: 1px solid #2a2a4a;
          overflow-y: auto;
        }
        .ruler-spacer {
          height: 28px;
          border-bottom: 1px solid #2a2a4a;
          flex-shrink: 0;
        }
        .track-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 10px;
          border-bottom: 1px solid #1a1a2e;
          flex-shrink: 0;
        }
        .track-delete {
          background: none;
          border: none;
          color: #555;
          cursor: pointer;
          font-size: 14px;
          padding: 2px 4px;
          border-radius: 3px;
          margin-left: auto;
        }
        .track-delete:hover {
          color: #ff5566;
          background: #1a1020;
        }
        .vis-toggle {
          cursor: pointer;
          font-size: 13px;
          opacity: 0.7;
        }
        .vis-toggle:hover { opacity: 1; }
        .track-info {
          display: flex;
          flex-direction: column;
          gap: 1px;
          overflow: hidden;
        }
        .track-name {
          font-size: 12px;
          color: #ccc;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .track-type {
          font-size: 9px;
          color: #555;
          text-transform: uppercase;
        }
        .add-track-btn {
          margin: 8px 10px;
          padding: 6px;
          background: #1a1a2e;
          color: #888;
          border: 1px dashed #333;
          border-radius: 4px;
          cursor: pointer;
          font-size: 11px;
          text-align: center;
        }
        .add-track-btn:hover {
          border-color: #4a3aff;
          color: #aaa;
        }
        .timeline-scroll {
          flex: 1;
          overflow-x: auto;
          overflow-y: auto;
          position: relative;
        }
        .ruler {
          position: relative;
          height: 28px;
          background: #0a0a14;
          border-bottom: 1px solid #2a2a4a;
          cursor: pointer;
          user-select: none;
        }
        .ruler-tick {
          position: absolute;
          top: 0;
          height: 100%;
          border-left: 1px solid #222;
          padding-left: 3px;
          font-size: 10px;
          color: #555;
          display: flex;
          align-items: center;
        }
        .track-lane {
          position: relative;
          border-bottom: 1px solid #1a1a2e;
          background-image: repeating-linear-gradient(
            90deg,
            transparent,
            transparent ${FRAME_PX * 30 - 1}px,
            rgba(255,255,255,0.015) ${FRAME_PX * 30 - 1}px,
            rgba(255,255,255,0.015) ${FRAME_PX * 30}px
          );
        }
        .clip {
          position: absolute;
          border-radius: 4px;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 4px;
          cursor: grab;
          user-select: none;
          overflow: hidden;
          color: #fff;
          font-size: 11px;
        }
        .clip:active { cursor: grabbing; }
        .clip.selected {
          outline: 2px solid #ff3366;
          outline-offset: 0;
          z-index: 10;
        }
        .clip.video { background: linear-gradient(135deg, #3b1d8a, #5b2dd9); }
        .clip.pano  { background: linear-gradient(135deg, #0d6e5a, #16a884); }
        .clip.image { background: linear-gradient(135deg, #1a5e7a, #2d8fb0); }
        .clip.text  { background: linear-gradient(135deg, #8a4f1d, #d97742); }
        .clip.audio { background: linear-gradient(135deg, #2d5a1e, #4a8a37); }
        .clip-thumb {
          font-size: 14px;
          flex-shrink: 0;
          width: 18px;
          text-align: center;
        }
        .clip-name {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;
        }
        .clip-dur {
          font-size: 9px;
          opacity: 0.6;
          flex-shrink: 0;
        }
        .trim-handle {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 12px;
          background: rgba(255,255,255,0.1);
          cursor: ew-resize;
          z-index: 5;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.1s;
        }
        .trim-handle::after {
          content: '';
          width: 3px;
          height: 60%;
          background: rgba(255,255,255,0.4);
          border-radius: 2px;
          transition: background 0.1s;
        }
        .trim-handle:hover { background: rgba(255,51,102,0.3); }
        .trim-handle:hover::after { background: #ff3366; }
        .trim-handle.left { left: 0; }
        .trim-handle.right { right: 0; }
        .playhead {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          background: #ff3366;
          pointer-events: none;
          z-index: 20;
        }
        .timeline-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-top: 1px solid #2a2a4a;
          background: #0d0d1a;
          flex-shrink: 0;
        }
        .clip-info {
          font-size: 11px;
          color: #888;
          flex: 1;
        }
        .hint {
          font-size: 11px;
          color: #444;
        }
        .btn {
          background: #1a1a2e;
          color: #ccc;
          border: 1px solid #2a2a4a;
          padding: 4px 10px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 11px;
        }
        .btn:hover { background: #25254a; }
        .btn-danger { color: #ff5566; border-color: #442028; }
        .btn-danger:hover { background: #2a1520; }
      `}</style>
    </div>
  );
};
