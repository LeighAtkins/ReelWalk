import { SUPPORTED_UPLOAD_TYPES } from "./uploads";

const KNOWN_INPUT_EXTENSIONS = new Set([...Object.values(SUPPORTED_UPLOAD_TYPES), "jpeg"]);

/** Object key for an upload. `ownerId` is the workspace (or a property, for older uploads). */
export function uploadKeyFor(ownerId: string, assetId: string, extension: string): string {
  return `uploads/${ownerId}/${assetId}.${extension}`;
}

/** JPEG thumbnail the browser makes for an upload. */
export function thumbKeyFor(objectKey: string): string {
  return objectKey.replace(/^uploads\//, "thumbs/").replace(/\.[a-z0-9]+$/i, "") + ".jpg";
}

/**
 * Thumbnail the worker cuts from a video's own frames, replacing the
 * browser's. A phone browser importing many videos at once can hand back a
 * black canvas before the frame is decoded; the worker's never is. A key of
 * its own, so no cache keeps serving the black one.
 */
export function frameThumbKeyFor(objectKey: string): string {
  return thumbKeyFor(objectKey).replace(/\.jpg$/, "-frame.jpg");
}

/**
 * The output key depends only on the job id. A retried or duplicated render
 * overwrites the same object instead of creating a second one.
 */
export function outputKeyFor(jobId: string, attempt?: number): string {
  // The first attempt keeps the plain key (every existing output); a retry gets its own.
  return attempt && attempt > 1 ? `renders/${jobId}-${attempt}.mp4` : `renders/${jobId}.mp4`;
}

/**
 * Local filename for the downloaded input. The extension is preserved from the
 * S3 key so the Remotion composition can tell images from videos; anything
 * unrecognised falls back to .mp4.
 */
export function inputFilenameFor(objectKey: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(objectKey);
  const ext = match ? match[1].toLowerCase() : "";
  return `input.${KNOWN_INPUT_EXTENSIONS.has(ext) ? ext : "mp4"}`;
}

/** The editor's preview rendition of an uploaded video. */
export function previewKeyFor(ownerId: string, assetId: string): string {
  return `previews/${ownerId}/${assetId}.mp4`;
}

/**
 * A 1080p copy of an uploaded video that the renderer reads instead of the
 * original. Phone footage is often 4K, and decoding four 4K clips at once
 * is what pushed the worker past its memory limit.
 */
export function renderSourceKeyFor(assetId: string): string {
  return `render-sources/${assetId}.mp4`;
}
