import { analyseAudio as analyseTrack, analyseSong, BEAT_SAMPLE_RATE, detectBeats, mediaKindFor, resolveUploadType, type AudioAnalysis as TrackAnalysis, type BeatGrid, type MediaKind, type SongMap } from "@reelwalk/core";
import { abortUpload, completeUpload, confirmUpload, createUpload } from "@/app/actions";
import type { LibraryAsset } from "@/lib/library";
import { roomHintFor } from "@/lib/pending-files";
import { shrinkVideo } from "./shrink";

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

/** Mean brightness (0-255) of a frame, from a small sample of its pixels. */
function brightness(source: CanvasImageSource): number {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) return 255;
  context.drawImage(source, 0, 0, 32, 32);
  const { data } = context.getImageData(0, 0, 32, 32);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return sum / (data.length / 4);
}

/** Darker than this and the frame is as good as black: a fade-in, a lens cap, a hand over the camera. */
const DARK_FRAME = 28;

function probeVideo(url: string): Promise<Omit<Probe, "kind">> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const fail = () => resolve({ durationMs: null, width: null, height: null, thumb: null });
    let tries = 0;
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
      // Phone videos often open on a dark frame (a fade-in, the lens still
      // covered); step further in, up to four times, until the frame has light in it.
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (width && height && duration > 1.5 && tries < 4 && brightness(video) < DARK_FRAME) {
        tries += 1;
        video.currentTime = Math.min(duration - 0.1, video.currentTime + Math.max(0.6, duration / 6));
        return;
      }
      const thumb = width && height ? await canvasToJpeg(video, width, height).catch(() => null) : null;
      resolve({
        durationMs: duration ? Math.round(duration * 1000) : null,
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

/** PUTs a body to a presigned URL; resolves with the ETag storage returns. */
function put(url: string, body: Blob, contentType: string | null, onProgress?: (fraction: number) => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve(request.getResponseHeader("ETag"))
        : reject(new Error(`Storage refused the upload (${request.status}).`));
    request.onerror = () => reject(new Error("The upload was interrupted. Check your connection."));
    request.open("PUT", url);
    // Must match the content type the URL was signed for (parts are signed without one).
    if (contentType) request.setRequestHeader("content-type", contentType);
    request.send(body);
  });
}

/**
 * Tempo of a song, found in the browser: decode the file, resample the first
 * 90 seconds to mono, and run the same detector the importer uses.
 */
async function detectTempo(file: File): Promise<{ beat: BeatGrid | null; songMap: SongMap | null }> {
  const { beat, songMap } = await analyseAudio(await file.arrayBuffer());
  return { beat, songMap };
}

export type AudioAnalysis = {
  durationMs: number | null;
  beat: BeatGrid | null;
  /** Bars and sections (ADR 0059), when it has a tempo. */
  songMap: SongMap | null;
  /** The full track analysis (ADR 0066: beat list, energy curve, drop), from the same samples; null when not decodable. */
  track: TrackAnalysis | null;
};
const UNREADABLE: AudioAnalysis = { durationMs: null, beat: null, songMap: null, track: null };

/** Decodes a song and finds its length and tempo. Both are null when the browser cannot decode it. */
async function analyseAudio(data: ArrayBuffer): Promise<AudioAnalysis> {
  try {
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(data);
    void context.close();
    const seconds = Math.min(90, decoded.duration);
    const offline = new OfflineAudioContext(1, Math.ceil(seconds * BEAT_SAMPLE_RATE), BEAT_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const beat = detectBeats(samples);
    return { durationMs: Math.round(decoded.duration * 1000), beat, songMap: beat ? analyseSong(samples, beat) : null, track: analyseTrack(samples) };
  } catch {
    // Not decodable here: the song still works, just without beat snapping.
    return UNREADABLE;
  }
}

/**
 * Stores the browser's track analysis where agents and the export page read
 * it (`GET /api/music/:audioId/analysis`, ADR 0066). Best effort: a failure
 * only means the worker analyses the track later.
 */
export async function storeTrackAnalysis(audioId: string, track: TrackAnalysis | null): Promise<void> {
  if (!track) return;
  try {
    await fetch(`/api/music/${encodeURIComponent(audioId)}/analysis`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ analysis: track }) });
  } catch {
    // The worker's analysis step covers it.
  }
}

/**
 * Length and tempo of a song already in storage (an Instagram sound's private
 * copy, ADR 0019): fetched from its presigned storage URL, which answers
 * CORS, never from Instagram's CDN, which does not.
 */
export async function analyseStoredAudio(url: string): Promise<AudioAnalysis> {
  try {
    const response = await fetch(url);
    if (!response.ok) return UNREADABLE;
    return await analyseAudio(await response.arrayBuffer());
  } catch {
    return UNREADABLE;
  }
}

/** Probes, uploads straight to storage, and records the asset. */
/** Tries again after 1, 3 and 9 seconds: phone connections drop for a moment and come back. */
async function withRetry<T>(work: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 3;
    }
  }
}

/** Uploads a big file in parts, three at a time, each part retried on its own. */
async function putParts(
  file: File,
  multipart: { uploadId: string; partBytes: number; partUrls: string[] },
  onProgress: (fraction: number) => void,
): Promise<{ partNumber: number; etag: string }[]> {
  const { partBytes, partUrls } = multipart;
  const sent = new Array<number>(partUrls.length).fill(0);
  const report = () => onProgress(sent.reduce((sum, bytes) => sum + bytes, 0) / file.size);
  const parts: { partNumber: number; etag: string }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < partUrls.length) {
      const index = next++;
      const body = file.slice(index * partBytes, Math.min(file.size, (index + 1) * partBytes));
      const etag = await withRetry(() => {
        sent[index] = 0;
        return put(partUrls[index], body, null, (fraction) => {
          sent[index] = fraction * body.size;
          report();
        });
      });
      if (!etag) throw new Error("Storage did not confirm part of the upload.");
      parts[index] = { partNumber: index + 1, etag };
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, partUrls.length) }, worker));
  return parts;
}

export async function uploadFile(original: File, onProgress: (fraction: number) => void): Promise<LibraryAsset> {
  // A 4K phone clip is shrunk to 1080 on the phone first (ADR 0024): the first
  // part of the bar is the shrink (which takes longer than sending the result), the rest the upload. The original's name is kept.
  const shrunk = original.type.startsWith("video/") ? await shrinkVideo(original, (fraction) => onProgress(fraction * 0.6)) : null;
  const file = shrunk?.file ?? original;
  if (shrunk) console.log(`shrink: ${original.name} ${(shrunk.from.bytes / 1048576).toFixed(1)} MB ${shrunk.from.width}x${shrunk.from.height} -> ${(file.size / 1048576).toFixed(1)} MB in ${shrunk.ms} ms`);
  const report = shrunk ? (fraction: number) => onProgress(0.6 + fraction * 0.4) : onProgress;
  const info = await probe(file);
  if (!info) throw new Error(`${file.name} is not a supported photo, video or audio file.`);
  const { beat, songMap } = info.kind === "AUDIO" ? await detectTempo(file) : { beat: null, songMap: null };

  const ticket = await withRetry(() =>
    createUpload({
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      withThumbnail: info.thumb !== null,
    }),
  );
  if (!ticket.ok) throw new Error(ticket.error);

  if (ticket.multipart) {
    const multipart = ticket.multipart;
    try {
      const parts = await putParts(file, multipart, report);
      const completed = await withRetry(() => completeUpload({ objectKey: ticket.objectKey, uploadId: multipart.uploadId, parts }));
      if (!completed.ok) throw new Error(completed.error);
    } catch (error) {
      void abortUpload({ objectKey: ticket.objectKey, uploadId: multipart.uploadId }).catch(() => undefined);
      throw error instanceof Error ? error : new Error(`Could not upload ${file.name}.`);
    }
  } else if (ticket.uploadUrl) {
    const uploadUrl = ticket.uploadUrl;
    await withRetry(() => put(uploadUrl, file, ticket.contentType, report));
  }
  if (ticket.thumbUrl && info.thumb) await put(ticket.thumbUrl, info.thumb, "image/jpeg").catch(() => undefined);

  // Safe to repeat: the asset row is keyed by its object key.
  const confirmed = await withRetry(() => confirmUpload({
    objectKey: ticket.objectKey,
    thumbKey: ticket.thumbKey,
    fileName: original.name,
    durationMs: info.durationMs,
    width: info.width,
    height: info.height,
    bpm: beat?.bpm ?? null,
    beatOffsetMs: beat?.offsetMs ?? null,
    // The shot it was filmed as, when it came from the shot list (ADR 0063).
    room: roomHintFor(original),
    songMap,
  }));
  if (!confirmed.ok) throw new Error(confirmed.error);
  return confirmed.asset;
}
