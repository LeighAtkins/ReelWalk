import { loadVideo, releaseVideo, seekVideo } from "./editor/frame-service";
import { inspectSource } from "@/app/inspect-actions";

/** Save the selected original source frame, without the reel's text, grade or camera effects. */
export async function shotFramePhoto(assetId: string, name: string, atMs: number): Promise<File> {
  if (!Number.isFinite(atMs) || atMs < 0) throw Error("Choose a valid video frame.");
  const source = await inspectSource({ assetId });
  if (!source?.url) throw Error("The original video is unavailable. Try again or upload a photo.");
  const video = await loadVideo(source.url);
  try {
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || atMs / 1000 >= video.duration) throw Error("This frame is outside the video. Choose another frame.");
    if (Math.abs(video.currentTime - atMs / 1000) > 0.0001) await seekVideo(video, atMs);
    const scale = Math.min(1, 4096 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    try {
      const context = canvas.getContext("2d"); if (!context) throw Error("Frame capture is unavailable.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error("Could not save this frame.")), "image/jpeg", 0.95));
      return new File([blob], `${name} frame ${atMs}ms.jpg`, { type: "image/jpeg" });
    } finally { canvas.width = canvas.height = 0; }
  } finally { releaseVideo(video); }
}
