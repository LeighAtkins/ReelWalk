/**
 * Browser-based video export using WebCodecs VideoEncoder + mp4-muxer.
 *
 * Each rendered canvas frame gets a precise timestamp, so a 300-frame
 * 10-second pano always produces exactly 10 seconds of video — regardless
 * of how long the rendering actually takes.
 *
 * Falls back to MediaRecorder for browsers without WebCodecs.
 */

import type { EditorProject, Clip } from "./types";
import { interpolateCamera, drawEquirect2D } from "./equirect";

export interface ExportOptions {
  fps: number;
  onProgress?: (frame: number, total: number) => void;
}

export interface ExportResult {
  blob: Blob;
  url: string;
  mimeType: string;
  extension: string;
}

/** Preload an HTMLVideoElement from a URL */
function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => resolve(video);
    video.onerror = () => reject(new Error(`Failed to load video: ${url}`));
    video.src = url;
  });
}

/** Preload an HTMLImageElement from a URL */
function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

interface LoadedAsset {
  type: "video" | "image";
  clipId: string;
  video?: HTMLVideoElement;
  image?: HTMLImageElement;
}

function drawPanoClipEquirect(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  image: HTMLImageElement,
  localFrame: number,
  totalFrames: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const startAngle = clip.panStartAngle ?? 0;
  const endAngle = clip.panEndAngle ?? 90;
  const startPitch = clip.startPitch ?? 0;
  const endPitch = clip.endPitch ?? 0;
  const startFov = clip.fov ?? 75;
  const endFov = clip.endFov ?? startFov;

  const progress = totalFrames > 1 ? localFrame / (totalFrames - 1) : 0;
  const cam = interpolateCamera(
    { yaw: startAngle, pitch: startPitch, fov: startFov },
    { yaw: endAngle, pitch: endPitch, fov: endFov },
    progress,
  );

  drawEquirect2D(ctx, image, cam, canvasWidth, canvasHeight, 0.5);
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  el: HTMLVideoElement | HTMLImageElement,
  targetW: number,
  targetH: number,
) {
  const srcW = "videoWidth" in el ? el.videoWidth : el.naturalWidth;
  const srcH = "videoHeight" in el ? el.videoHeight : el.naturalHeight;
  if (!srcW || !srcH) return;

  const srcRatio = srcW / srcH;
  const targetRatio = targetW / targetH;

  let sx = 0, sy = 0, sw = srcW, sh = srcH;

  if (srcRatio > targetRatio) {
    sw = srcH * targetRatio;
    sx = (srcW - sw) / 2;
  } else {
    sh = srcW / targetRatio;
    sy = (srcH - sh) / 2;
  }

  ctx.drawImage(el, sx, sy, sw, sh, 0, 0, targetW, targetH);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
}

/**
 * Render a single frame of the timeline onto ctx.
 */
async function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  panoCtx: CanvasRenderingContext2D,
  panoCanvas: HTMLCanvasElement,
  project: EditorProject,
  assets: Map<string, LoadedAsset>,
  frame: number,
  width: number,
  height: number,
  fps: number,
) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  for (const track of project.tracks) {
    if (!track.visible) continue;

    for (const clip of track.clips) {
      if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;

      const localFrame = frame - clip.startFrame;
      const asset = assets.get(clip.id);

      if (clip.type === "video" && asset?.video) {
        const video = asset.video;
        const trimStart = clip.trimStart ?? 0;
        const targetTime = (trimStart + localFrame) / fps;

        try {
          video.currentTime = Math.min(targetTime, video.duration || 0);
          await new Promise<void>((r) => {
            const onSeeked = () => { video.removeEventListener("seeked", onSeeked); r(); };
            video.addEventListener("seeked", onSeeked);
            setTimeout(() => { video.removeEventListener("seeked", onSeeked); r(); }, 100);
          });
        } catch { /* continue if seek fails */ }

        drawCover(ctx, video, width, height);
      }

      if (clip.type === "image" && asset?.image) {
        drawCover(ctx, asset.image, width, height);
      }

      if (clip.type === "pano" && asset?.image) {
        panoCanvas.width = width;
        panoCanvas.height = height;
        drawPanoClipEquirect(panoCtx, clip, asset.image, localFrame, clip.durationFrames, width, height);
        ctx.drawImage(panoCanvas, 0, 0);
      }

      if (clip.type === "text") {
        ctx.fillStyle = clip.color ?? "#ffffff";
        ctx.font = `bold ${clip.fontSize ?? 64}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 4;

        const maxWidth = width - 120;
        const lines = wrapText(ctx, clip.text ?? "", maxWidth);
        const lineHeight = (clip.fontSize ?? 64) * 1.3;
        const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;

        lines.forEach((line, i) => {
          ctx.fillText(line, width / 2, startY + i * lineHeight);
        });

        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }
    }
  }
}

/**
 * Check if WebCodecs VideoEncoder is available.
 */
function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/**
 * Export using WebCodecs VideoEncoder + mp4-muxer.
 * Each frame gets a precise timestamp — output duration always matches timeline.
 */
async function exportWithWebCodecs(
  project: EditorProject,
  options: ExportOptions,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  panoCanvas: HTMLCanvasElement,
  panoCtx: CanvasRenderingContext2D,
  assets: Map<string, LoadedAsset>,
  totalFrames: number,
  width: number,
  height: number,
): Promise<ExportResult> {
  const { fps, onProgress } = options;

  // Dynamically import mp4-muxer
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: "avc",
      width,
      height,
    },
    fastStart: "in-memory",
  });

  // Configure encoder
  let encodedChunks: Uint8Array[] = [];
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error("VideoEncoder error:", e);
    },
  });

  // Find supported codec
  const codecCandidates = [
    "avc1.42E01F", // H.264 Baseline 3.1
    "avc1.42001F", // H.264 Baseline 3.1
    "avc1.4D401F", // H.264 Main 3.1
    "avc1.640028", // H.264 High 4.0
  ];

  let configuredCodec = "";
  for (const codec of codecCandidates) {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate: 10_000_000,
      framerate: fps,
    });
    if (support.supported) {
      configuredCodec = codec;
      break;
    }
  }

  if (!configuredCodec) {
    throw new Error("No supported H.264 codec found");
  }

  encoder.configure({
    codec: configuredCodec,
    width,
    height,
    bitrate: 10_000_000,
    framerate: fps,
  });

  const frameDurationUs = Math.round(1_000_000 / fps);

  for (let frame = 0; frame < totalFrames; frame++) {
    onProgress?.(frame, totalFrames);

    await renderFrame(ctx, canvas, panoCtx, panoCanvas, project, assets, frame, width, height, fps);

    // Create VideoFrame from canvas with explicit timestamp
    const videoFrame = new VideoFrame(canvas, {
      timestamp: frame * frameDurationUs,
      duration: frameDurationUs,
    });

    encoder.encode(videoFrame, { keyFrame: frame % 30 === 0 });
    videoFrame.close();

    // Throttle encoding to avoid memory buildup
    if (encoder.encodeQueueSize > 10) {
      await new Promise((r) => setTimeout(r, 10));
      while (encoder.encodeQueueSize > 5) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  }

  await encoder.flush();
  muxer.finalize();

  const { buffer } = muxer.target as any;
  const blob = new Blob([buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);

  return { blob, url, mimeType: "video/mp4", extension: "mp4" };
}

/**
 * Fallback export using MediaRecorder (for browsers without WebCodecs).
 * Uses manual frame capture.
 */
async function exportWithMediaRecorder(
  project: EditorProject,
  options: ExportOptions,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  panoCanvas: HTMLCanvasElement,
  panoCtx: CanvasRenderingContext2D,
  assets: Map<string, LoadedAsset>,
  totalFrames: number,
  width: number,
  height: number,
): Promise<ExportResult> {
  const { fps, onProgress } = options;

  const candidates = [
    { mimeType: "video/mp4;codecs=h264", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
  ];

  let mimeType = "video/webm";
  let extension = "webm";
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) {
      mimeType = c.mimeType;
      extension = c.extension;
      break;
    }
  }

  const stream = canvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 10_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const recordingDone = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

  // Render and capture each frame
  for (let frame = 0; frame < totalFrames; frame++) {
    onProgress?.(frame, totalFrames);

    await renderFrame(ctx, canvas, panoCtx, panoCanvas, project, assets, frame, width, height, fps);

    if ("requestFrame" in videoTrack) {
      (videoTrack as any).requestFrame();
    }
    // Let the recorder process
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }

  // Wait for last frame to be captured
  await new Promise((r) => setTimeout(r, 300));
  recorder.start();
  await new Promise((r) => setTimeout(r, 100));

  // Re-render all frames for the actual recording
  for (let frame = 0; frame < totalFrames; frame++) {
    onProgress?.(frame, totalFrames);
    await renderFrame(ctx, canvas, panoCtx, panoCanvas, project, assets, frame, width, height, fps);
    if ("requestFrame" in videoTrack) {
      (videoTrack as any).requestFrame();
    }
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }

  await new Promise((r) => setTimeout(r, 200));
  recorder.stop();
  await recordingDone;
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  return { blob, url, mimeType, extension };
}

/**
 * Main export function. Renders project frame-by-frame and encodes to video.
 * Uses WebCodecs when available (frame-accurate timestamps), falls back to MediaRecorder.
 */
export async function exportProject(
  project: EditorProject,
  options: ExportOptions,
): Promise<ExportResult> {
  const { fps, onProgress } = options;
  const { width, height } = project;

  // Calculate total duration
  let totalFrames = 1;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clip.startFrame + clip.durationFrames;
      if (end > totalFrames) totalFrames = end;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  const panoCanvas = document.createElement("canvas");
  const panoCtx = panoCanvas.getContext("2d")!;

  // Preload all assets
  const assets = new Map<string, LoadedAsset>();
  const allClips = project.tracks.flatMap((t) => t.clips);

  for (const clip of allClips) {
    if (!clip.assetUrl) continue;
    try {
      if (clip.type === "video") {
        const video = await loadVideoElement(clip.assetUrl);
        video.currentTime = clip.trimStart ?? 0;
        await new Promise<void>((resolve) => {
          const onReady = () => { video.removeEventListener("seeked", onReady); resolve(); };
          video.addEventListener("seeked", onReady);
          setTimeout(() => { video.removeEventListener("seeked", onReady); resolve(); }, 500);
        });
        assets.set(clip.id, { type: "video", clipId: clip.id, video });
      } else if (clip.type === "image" || clip.type === "pano") {
        const image = await loadImageElement(clip.assetUrl);
        assets.set(clip.id, { type: "image", clipId: clip.id, image });
      }
    } catch (err) {
      console.warn(`Failed to load asset for clip ${clip.name}:`, err);
    }
  }

  // Choose export path
  if (hasWebCodecs()) {
    console.log("[export] Using WebCodecs VideoEncoder (frame-accurate)");
    return exportWithWebCodecs(
      project, options, canvas, ctx, panoCanvas, panoCtx,
      assets, totalFrames, width, height,
    );
  }

  console.log("[export] WebCodecs unavailable, falling back to MediaRecorder");
  return exportWithMediaRecorder(
    project, options, canvas, ctx, panoCanvas, panoCtx,
    assets, totalFrames, width, height,
  );
}

export function canExportClientSide(): boolean {
  return (
    typeof HTMLCanvasElement !== "undefined" &&
    (hasWebCodecs() || (typeof HTMLCanvasElement.prototype.captureStream === "function" && typeof MediaRecorder !== "undefined"))
  );
}
