import React, { useRef, useState } from "react";
import { useEditorStore } from "../store";
import type { ClipType } from "../types";
import { canExportClientSide, exportProject } from "../export";

export const Toolbar: React.FC = () => {
  const project = useEditorStore((s) => s.project);
  const addClipToTrack = useEditorStore((s) => s.addClipToTrack);
  const addTrack = useEditorStore((s) => s.addTrack);
  const setProjectSize = useEditorStore((s) => s.setProjectSize);
  const exportJSON = useEditorStore((s) => s.exportProject);

  const videoInputRef = useRef<HTMLInputElement>(null);
  const panoInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportExt, setExportExt] = useState("webm");
  const [exportError, setExportError] = useState<string | null>(null);

  const handleFile = (files: FileList | null, type: ClipType) => {
    const file = files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const name = file.name.replace(/\.[^.]+$/, "");

    let track = project.tracks.find((t) => {
      if (type === "pano") return t.type === "pano";
      return t.type === type;
    });
    // Auto-create the right track type if none exists
    if (!track) {
      addTrack(type === "pano" ? "pano" : type);
      // Use setTimeout to let the store update, then find the new track
      setTimeout(() => {
        const state = useEditorStore.getState();
        const newTrack = state.project.tracks.find(
          (t) => t.type === type || (type === "pano" && t.type === "pano")
        );
        if (newTrack) addClipToTrack(newTrack.id, type, url, name);
      }, 0);
      return;
    }
    addClipToTrack(track.id, type, url, name);
  };

  const handleExportJSON = () => {
    const data = exportJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.name || "project"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportVideo = async () => {
    setExporting(true);
    setExportProgress(0);
    setExportUrl(null);
    setExportError(null);

    try {
      const result = await exportProject(project, {
        fps: project.fps,
        onProgress: (frame, total) => {
          setExportProgress(Math.round((frame / total) * 100));
        },
      });

      setExportUrl(result.url);
      setExportExt(result.extension);
    } catch (err) {
      console.error("Export failed:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const clientSideSupported = canExportClientSide();

  return (
    <div className="toolbar">
      <div className="tb-group">
        <select
          onChange={(e) =>
            setProjectSize(e.target.value as "vertical" | "horizontal" | "square")
          }
          defaultValue="vertical"
          className="tb-select"
        >
          <option value="vertical">📋 9:16</option>
          <option value="horizontal">🖥 16:9</option>
          <option value="square">⬜ 1:1</option>
        </select>
      </div>

      <div className="tb-divider" />

      <div className="tb-group">
        <input ref={videoInputRef} type="file" accept="video/*" hidden onChange={(e) => handleFile(e.target.files, "video")} />
        <button className="tb-btn" onClick={() => videoInputRef.current?.click()}>🎬 Video</button>

        <input ref={panoInputRef} type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files, "pano")} />
        <button className="tb-btn pano" onClick={() => panoInputRef.current?.click()}>🌐 360°</button>

        <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files, "image")} />
        <button className="tb-btn" onClick={() => imageInputRef.current?.click()}>🖼 Image</button>

        <input ref={audioInputRef} type="file" accept="audio/*" hidden onChange={(e) => handleFile(e.target.files, "audio")} />
        <button className="tb-btn" onClick={() => audioInputRef.current?.click()}>🎵 Audio</button>

        <button
          className="tb-btn"
          onClick={() => {
            const textTrack = project.tracks.find((t) => t.type === "text");
            if (textTrack) {
              addClipToTrack(textTrack.id, "text", "", "Text");
            } else {
              addTrack("text");
              setTimeout(() => {
                const t = useEditorStore.getState().project.tracks.find((t) => t.type === "text");
                if (t) addClipToTrack(t.id, "text", "", "Text");
              }, 0);
            }
          }}
        >
          ✏️ Text
        </button>
      </div>

      <div className="tb-divider" />

      <div className="tb-group">
        <button className="tb-btn small" onClick={() => addTrack("video")}>+ Video Track</button>
        <button className="tb-btn small" onClick={() => addTrack("pano")}>+ 360 Track</button>
        <button className="tb-btn small" onClick={() => addTrack("audio")}>+ Audio Track</button>
      </div>

      <div className="tb-spacer" />

      {/* Export progress */}
      {exporting && (
        <div className="export-progress">
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${exportProgress}%` }} />
          </div>
          <span className="progress-text">Rendering {exportProgress}%</span>
        </div>
      )}

      {exportError && (
        <span className="export-err">⚠️ {exportError}</span>
      )}

      {exportUrl && !exporting && (
        <a className="tb-btn download-btn" href={exportUrl} download={`reelwalk-export.${exportExt}`}>
          ⬇ Download Video ({exportExt.toUpperCase()})
        </a>
      )}

      <button className="tb-btn" onClick={handleExportJSON}>📄 JSON</button>
      <button
        className="tb-btn export"
        onClick={handleExportVideo}
        disabled={exporting || !clientSideSupported}
      >
        {exporting ? `⏳ ${exportProgress}%` : "🎬 Export Video"}
      </button>

      <style>{`
        .toolbar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          background: #0a0a14;
          border-bottom: 1px solid #2a2a4a;
          flex-wrap: wrap;
          flex-shrink: 0;
        }
        .tb-group { display: flex; gap: 4px; align-items: center; }
        .tb-divider { width: 1px; height: 22px; background: #2a2a4a; }
        .tb-spacer { flex: 1; }
        .tb-select {
          background: #1a1a2e; color: #ccc; border: 1px solid #2a2a4a;
          padding: 5px 8px; border-radius: 4px; font-size: 12px;
        }
        .tb-btn {
          background: #1a1a2e; color: #ccc; border: 1px solid #2a2a4a;
          padding: 5px 10px; border-radius: 4px; cursor: pointer;
          font-size: 12px; white-space: nowrap; transition: all 0.12s;
          text-decoration: none; display: inline-flex; align-items: center;
        }
        .tb-btn:hover { background: #25254a; color: #fff; }
        .tb-btn:disabled { opacity: 0.5; cursor: wait; }
        .tb-btn.small { font-size: 11px; padding: 4px 8px; }
        .tb-btn.pano { border-color: #16a884; color: #16a884; }
        .tb-btn.pano:hover { background: #0d3a30; }
        .tb-btn.export {
          background: #4a3aff; border-color: #4a3aff; color: #fff; font-weight: 600;
        }
        .tb-btn.export:hover { background: #5b4dff; }
        .tb-btn.download-btn {
          background: #16a884; border-color: #16a884; color: #fff; font-weight: 600;
        }
        .export-progress {
          display: flex; align-items: center; gap: 8px;
          background: #1a1a2e; padding: 4px 10px; border-radius: 4px;
          border: 1px solid #2a2a4a;
        }
        .progress-track {
          width: 80px; height: 4px; background: #2a2a4a; border-radius: 2px; overflow: hidden;
        }
        .progress-bar {
          height: 100%; background: #4a3aff; border-radius: 2px; transition: width 0.1s;
        }
        .progress-text {
          font-size: 11px; color: #888; white-space: nowrap;
        }
        .export-err {
          font-size: 11px; color: #ff5566; white-space: nowrap;
        }
      `}</style>
    </div>
  );
};
