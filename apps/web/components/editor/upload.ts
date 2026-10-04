import { BEAT_SAMPLE_RATE, detectBeats, mediaKindFor, resolveUploadType, type BeatGrid, type MediaKind } from "@reelwalk/core";
import { confirmUpload, createUpload } from "@/app/actions";
import type { LibraryAsset } from "@/lib/library";

type Probe = { kind: MediaKind; durationMs: number | null; width: number | null; height: number | null; thumb: Blob | null };

const THUMB_HEIGHT = 240;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

function canvasToJpeg(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const scale = THUMB_HEIGHT / height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = THUMB_HEIGHT;
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
}

function probeVideo(url: string): Promise<Omit<Probe, "kind">> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const fail = () => resolve({ durationMs: null, width: null, height: null, thumb: null });
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onerror = fail;
    video.onloadedmetadata = () => {
      // A frame a little way in is more representative than a black first frame.
      video.currentTime = Math.min(0.5, (video.duration || 1) / 3);
    };
    video.onseeked = async () => {
      const width = video.videoWidth || null;
      const height = video.videoHeight || null;
      const thumb = width && height ? await canvasToJpeg(video, width, height).catch(() => null) : null;
      resolve({
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
        width,
        height,
        thumb,
      });
    };
    video.src = url;
  });
}

function probeImage(url: string): Promise<Omit<Probe, "kind">> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onerror = () => resolve({ durationMs: null, width: null, height: null, thumb: null });
    image.onload = async () => {
      const thumb = await canvasToJpeg(image, image.naturalWidth, image.naturalHeight).catch(() => null);
      resolve({ durationMs: null, width: image.naturalWidth, height: image.naturalHeight, thumb });
    };
    image.src = url;
  });
}

function probeAudio(url: string): Promise<Omit<Probe, "kind">> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.onerror = () => resolve({ durationMs: null, width: null, height: null, thumb: null });
    audio.onloadedmetadata = () =>
      resolve({
        durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null,
        width: null,
        height: null,
        thumb: null,
      });
    audio.src = url;
  });
}

/**
 * Reads duration and size, and draws a thumbnail, in the browser before
 * uploading. The server never has to download or decode the file for this.
 */
export async function probe(file: File): Promise<Probe | null> {
  const resolved = resolveUploadType(file.type, file.name);
  if (!resolved) return null;
  const kind = mediaKindFor(resolved.contentType);
  const url = URL.createObjectURL(file);
  const empty = { durationMs: null, width: null, height: null, thumb: null };
  try {
    const probeFor = kind === "VIDEO" ? probeVideo : kind === "IMAGE" ? probeImage : probeAudio;
    // Some phone formats (HEVC on desktop browsers) cannot be decoded here; upload them anyway.
    return { kind, ...(await withTimeout(probeFor(url), 10_000, empty)) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function put(url: string, body: Blob, contentType: string, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Storage refused the upload (${request.status}).`));
    request.onerror = () => reject(new Error("The upload was interrupted. Check your connection."));
    request.open("PUT", url);
    // Must match the content type the URL was signed for.
    request.setRequestHeader("content-type", contentType);
    request.send(body);
  });
}

/**
 * Tempo of a song, found in the browser: decode the file, resample the first
 * 90 seconds to mono, and run the same detector the importer uses.
 */
async function detectTempo(file: File): Promise<BeatGrid | null> {
  try {
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    void context.close();
    const seconds = Math.min(90, decoded.duration);
    const offline = new OfflineAudioContext(1, Math.ceil(seconds * BEAT_SAMPLE_RATE), BEAT_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return detectBeats(rendered.getChannelData(0));
  } catch {
    // Not decodable here: the song still works, just without beat snapping.
    return null;
  }
}

/** Probes, uploads straight to storage, and records the asset. */
export async function uploadFile(file: File, onProgress: (fraction: number) => void): Promise<LibraryAsset> {
  const info = await probe(file);
  if (!info) throw new Error(`${file.name} is not a supported photo, video or audio file.`);
  const beat = info.kind === "AUDIO" ? await detectTempo(file) : null;

  const ticket = await createUpload({
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    withThumbnail: info.thumb !== null,
  });
  if (!ticket.ok) throw new Error(ticket.error);

  await put(ticket.uploadUrl, file, ticket.contentType, onProgress);
  if (ticket.thumbUrl && info.thumb) await put(ticket.thumbUrl, info.thumb, "image/jpeg").catch(() => undefined);

  const confirmed = await confirmUpload({
    objectKey: ticket.objectKey,
    thumbKey: ticket.thumbKey,
    fileName: file.name,
    durationMs: info.durationMs,
    width: info.width,
    height: info.height,
    bpm: beat?.bpm ?? null,
    beatOffsetMs: beat?.offsetMs ?? null,
  });
  if (!confirmed.ok) throw new Error(confirmed.error);
  return confirmed.asset;
}
