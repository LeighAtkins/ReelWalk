import React, { useRef, useEffect, useMemo, useCallback } from "react";
import { Player } from "@remotion/player";
import { useEditorStore } from "../store";
import { TimelineComposition } from "../composition";

export const PreviewPanel: React.FC = () => {
  const project = useEditorStore((s) => s.project);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const totalDuration = useEditorStore((s) => s.totalDuration);
  const playerRef = useRef<any>(null);

  // Refs to avoid stale closures
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // Memoize inputProps — stable reference, only changes when project changes
  const inputProps = useMemo(() => ({ project }), [project]);

  // Frame update callback — stable, reads from ref
  const handleFrameUpdate = useCallback((e: { detail: { frame: number } }) => {
    if (isPlayingRef.current) {
      setCurrentFrame(e.detail.frame);
    }
  }, [setCurrentFrame]);

  // Attach event listener to Player ref (Remotion uses event emitter, not props)
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.addEventListener("frameupdate", handleFrameUpdate);
    return () => {
      player.removeEventListener("frameupdate", handleFrameUpdate);
    };
  }, [handleFrameUpdate]);

  // Sync play/pause → Player
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (isPlaying) {
      player.play();
    } else {
      player.pause();
    }
  }, [isPlaying]);

  // When paused, seek to currentFrame (scrubber / ruler / click)
  useEffect(() => {
    if (playerRef.current && !isPlaying) {
      playerRef.current.seekTo(currentFrame);
    }
  }, [currentFrame, isPlaying]);

  return (
    <div className="preview-panel">
      <div className="preview-wrapper">
        <Player
          ref={playerRef}
          component={TimelineComposition}
          inputProps={inputProps}
          durationInFrames={totalDuration}
          compositionWidth={project.width}
          compositionHeight={project.height}
          fps={project.fps}
          style={{
            width: "100%",
            height: "100%",
            maxHeight: "60vh",
          }}
          controls={false}
          loop
          acknowledgeRemotionLicense
        />
      </div>

      <div className="playback-controls">
        <button className="play-btn" onClick={() => setPlaying(!isPlaying)}>
          {isPlaying ? "⏸" : "▶"}
        </button>
        <span className="time-display">
          {formatTime(currentFrame, project.fps)} / {formatTime(totalDuration, project.fps)}
        </span>
        <input
          type="range"
          min={0}
          max={totalDuration}
          value={currentFrame}
          onChange={(e) => {
            setPlaying(false);
            setCurrentFrame(Number(e.target.value));
          }}
          className="scrubber"
          style={{ width: "100%" }}
        />
      </div>

      <style>{`
        .preview-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 16px;
          background: #0a0a14;
          min-width: 0;
        }
        .preview-wrapper {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          flex: 1;
          min-height: 0;
        }
        .playback-controls {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          max-width: 600px;
          padding: 8px 0;
        }
        .play-btn {
          background: #ff3366; color: #fff; border: none;
          width: 40px; height: 40px; border-radius: 50%;
          cursor: pointer; font-size: 16px; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .time-display { font-size: 12px; color: #888; white-space: nowrap; flex-shrink: 0; }
        .scrubber { accent-color: #ff3366; }
      `}</style>
    </div>
  );
};

function formatTime(frame: number, fps: number): string {
  const totalSec = frame / fps;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  const frm = frame % fps;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}:${String(frm).padStart(2, "0")}`;
}
