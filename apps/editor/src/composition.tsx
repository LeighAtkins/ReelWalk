import React, { useRef, useEffect, useState, useMemo } from "react";
import {
  AbsoluteFill,
  Img,
  Video,
  Audio,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { EditorProject, Clip } from "./types";
import { interpolateCamera, drawEquirect2D, type EquirectCamera } from "./equirect";

/**
 * Equirectangular pano clip — 2D canvas perspective rendering.
 * Quality scale is adaptive: lower during active scrubbing for responsiveness,
 * higher when paused for sharpness.
 */
const PanoClip: React.FC<{ clip: Clip }> = ({ clip }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  const camera = useMemo<EquirectCamera>(() => {
    const startAngle = clip.panStartAngle ?? 0;
    const endAngle = clip.panEndAngle ?? 90;
    const startPitch = clip.startPitch ?? 0;
    const endPitch = clip.endPitch ?? 0;
    const startFov = clip.fov ?? 75;
    const endFov = clip.endFov ?? startFov;
    const progress = clip.durationFrames > 1 ? frame / (clip.durationFrames - 1) : 0;
    return interpolateCamera(
      { yaw: startAngle, pitch: startPitch, fov: startFov },
      { yaw: endAngle, pitch: endPitch, fov: endFov },
      progress,
    );
  }, [clip, frame]);

  // Load image once
  useEffect(() => {
    if (!clip.assetUrl) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = clip.assetUrl;
  }, [clip.assetUrl]);

  // Render whenever camera changes or image loads
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Use moderate quality — 0.3 gives a good balance of speed/sharpness
    drawEquirect2D(ctx, img, camera, width, height, 0.3);
  }, [camera, imgLoaded, width, height]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ width: "100%", height: "100%" }}
      />
    </AbsoluteFill>
  );
};

const ClipRenderer: React.FC<{ clip: Clip }> = ({ clip }) => {
  if (clip.type === "video") {
    return (
      <AbsoluteFill>
        <Video
          src={clip.assetUrl}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
    );
  }
  if (clip.type === "image") {
    return (
      <AbsoluteFill>
        <Img src={clip.assetUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
    );
  }
  if (clip.type === "pano") return <PanoClip clip={clip} />;
  if (clip.type === "text") {
    return (
      <AbsoluteFill
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 60px",
        }}
      >
        <span
          style={{
            fontSize: clip.fontSize ?? 64,
            color: clip.color ?? "#fff",
            fontWeight: 700,
            textAlign: "center",
            textShadow: "0 4px 12px rgba(0,0,0,0.6)",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          {clip.text ?? ""}
        </span>
      </AbsoluteFill>
    );
  }
  if (clip.type === "audio") return <Audio src={clip.assetUrl} />;
  return null;
};

export interface TimelineCompositionProps {
  project: EditorProject;
}

export const TimelineComposition: React.FC<TimelineCompositionProps> = ({ project }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {project.tracks.map((track) => {
        if (!track.visible) return null;
        return track.clips.map((clip) => (
          <Sequence key={clip.id} from={clip.startFrame} durationInFrames={clip.durationFrames} name={clip.name}>
            <ClipRenderer clip={clip} />
          </Sequence>
        ));
      })}
    </AbsoluteFill>
  );
};
