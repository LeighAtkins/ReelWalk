import React from "react";
import { useEditorStore } from "../store";
import { PanoFramer } from "./PanoFramer";

/** Clip properties — contextual to selected clip type */
export const PropertiesPanel: React.FC = () => {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const project = useEditorStore((s) => s.project);
  const updateClip = useEditorStore((s) => s.updateClip);
  const removeClip = useEditorStore((s) => s.removeClip);
  const selectClip = useEditorStore((s) => s.selectClip);

  const clip = project.tracks
    .flatMap((t) => t.clips)
    .find((c) => c.id === selectedClipId);

  if (!clip) {
    return (
      <div className="props-empty">
        <span className="props-icon">🎬</span>
        <p>Select a clip to edit</p>
        <p className="props-hint">Tap a clip on the timeline</p>
      </div>
    );
  }

  const durSec = (clip.durationFrames / project.fps).toFixed(1);

  return (
    <div className="props-panel">
      {/* Back button — OUTSIDE the scroll area, always visible */}
      <div className="props-header">
        <button className="props-back" onClick={() => selectClip(null)}>
          ← Back to Timeline
        </button>
        <div className="props-clip-info">
          <span className="props-type-badge">
            {clip.type === "pano" ? "360° PHOTO" : clip.type.toUpperCase()}
          </span>
          <span className="props-name">{clip.name}</span>
        </div>
      </div>

      {/* Scrollable content area */}
      <div className="props-content">
        {/* Duration */}
        <div className="prop-row">
          <label>Duration</label>
          <div className="prop-inline">
            <input
              type="number" min={1} step={1}
              value={clip.durationFrames}
              onChange={(e) =>
                updateClip(clip.id, { durationFrames: Math.max(1, Number(e.target.value)) })
              }
            />
            <span className="prop-unit">frames ({durSec}s)</span>
          </div>
        </div>

        {/* 360 Pano controls */}
        {clip.type === "pano" && (
          <>
            <div className="prop-section">360° Camera — Street View Mode</div>
            {clip.assetUrl && (
              <PanoFramer
                imageUrl={clip.assetUrl}
                startAngle={clip.panStartAngle ?? 0}
                endAngle={clip.panEndAngle ?? 90}
                startPitch={clip.startPitch ?? 0}
                endPitch={clip.endPitch ?? 0}
                fov={clip.fov ?? 75}
                onChange={(u) =>
                  updateClip(clip.id, {
                    panStartAngle: u.startAngle,
                    panEndAngle: u.endAngle,
                    startPitch: u.startPitch,
                    endPitch: u.endPitch,
                    fov: u.fov,
                    endFov: u.fov,
                  })
                }
              />
            )}
          </>
        )}

        {/* Text controls */}
        {clip.type === "text" && (
          <>
            <div className="prop-section">Text</div>
            <div className="prop-row">
              <textarea
                value={clip.text ?? ""}
                onChange={(e) => updateClip(clip.id, { text: e.target.value })}
                rows={2}
                className="prop-textarea"
              />
            </div>
            <div className="prop-row">
              <label>Font Size: {clip.fontSize ?? 64}px</label>
              <input
                type="range" min={20} max={200} step={2}
                value={clip.fontSize ?? 64}
                onChange={(e) => updateClip(clip.id, { fontSize: Number(e.target.value) })}
                className="slider"
              />
            </div>
            <div className="prop-row">
              <label>Color</label>
              <input
                type="color"
                value={clip.color ?? "#ffffff"}
                onChange={(e) => updateClip(clip.id, { color: e.target.value })}
                className="prop-color"
              />
            </div>
          </>
        )}

        <div className="props-footer">
          <button className="btn-danger" onClick={() => { removeClip(clip.id); selectClip(null); }}>
            🗑 Delete Clip
          </button>
        </div>
      </div>

      <style>{`
        .props-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: #0d0d1a;
        }
        .props-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          background: #0d0d1a;
          text-align: center;
        }
        .props-empty .props-icon { font-size: 32px; opacity: 0.3; }
        .props-empty p { font-size: 12px; color: #555; margin-top: 8px; }
        .props-empty .props-hint { font-size: 10px; color: #333; }

        /* Header — fixed, never scrolls. Back button always visible. */
        .props-header {
          flex-shrink: 0;
          padding: 12px;
          border-bottom: 1px solid #2a2a4a;
          background: #0d0d1a;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .props-back {
          background: #ff3366;
          color: #fff;
          border: none;
          padding: 12px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 15px;
          font-weight: 700;
          width: 100%;
          text-align: center;
        }
        .props-back:active { background: #e02856; }
        .props-clip-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .props-type-badge {
          font-size: 9px;
          color: #888;
          letter-spacing: 0.8px;
        }
        .props-name {
          font-size: 13px;
          color: #fff;
          font-weight: 600;
        }

        /* Scrollable content — only this part scrolls */
        .props-content {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .prop-section {
          font-size: 10px;
          color: #4a3aff;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-top: 4px;
          padding-top: 8px;
          border-top: 1px solid #1a1a2e;
        }
        .prop-row {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .prop-row label {
          font-size: 11px;
          color: #666;
        }
        .prop-hint {
          font-size: 9px;
          color: #444;
        }
        .prop-inline {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .prop-row input[type="number"] {
          width: 70px;
          background: #1a1a2e;
          border: 1px solid #2a2a4a;
          color: #ddd;
          padding: 4px 6px;
          border-radius: 3px;
          font-size: 12px;
        }
        .prop-unit {
          font-size: 10px;
          color: #555;
        }
        .slider {
          width: 100%;
          accent-color: #ff3366;
        }
        .prop-textarea {
          width: 100%;
          background: #1a1a2e;
          border: 1px solid #2a2a4a;
          color: #ddd;
          padding: 6px;
          border-radius: 3px;
          font-size: 12px;
          resize: vertical;
          font-family: inherit;
        }
        .prop-color {
          width: 100%;
          height: 30px;
          background: #1a1a2e;
          border: 1px solid #2a2a4a;
          border-radius: 3px;
          cursor: pointer;
        }
        .props-footer {
          margin-top: auto;
          padding-top: 16px;
        }
        .btn-danger {
          width: 100%;
          background: #1a1020;
          color: #ff5566;
          border: 1px solid #3a1525;
          padding: 8px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        .btn-danger:hover { background: #2a1525; }

        /* Desktop: fixed-width sidebar */
        @media (min-width: 769px) {
          .props-panel {
            width: 240px;
            flex-shrink: 0;
            border-left: 1px solid #2a2a4a;
          }
        }
      `}</style>
    </div>
  );
};
