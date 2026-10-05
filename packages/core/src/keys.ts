import { SUPPORTED_UPLOAD_TYPES } from "./uploads";

const KNOWN_INPUT_EXTENSIONS = new Set([...Object.values(SUPPORTED_UPLOAD_TYPES), "jpeg"]);

export function uploadKeyFor(propertyId: string, assetId: string, extension: string): string {
  return `uploads/${propertyId}/${assetId}.${extension}`;
}

/**
 * The output key depends only on the job id. A retried or duplicated render
 * overwrites the same object instead of creating a second one.
 */
export function outputKeyFor(jobId: string): string {
  return `renders/${jobId}.mp4`;
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
