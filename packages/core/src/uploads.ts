export type MediaKind = "VIDEO" | "IMAGE" | "AUDIO";

/**
 * Content types the render pipeline can consume, mapped to the object key
 * extension. The worker and the Remotion composition rely on this extension to
 * tell still images from video, so it must be preserved end to end.
 */
export const SUPPORTED_UPLOAD_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  // Music tracks.
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

const EXTENSION_TO_TYPE: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SUPPORTED_UPLOAD_TYPES).map(([type, ext]) => [ext, type])),
  jpeg: "image/jpeg",
};

export type ResolvedUpload = { contentType: string; extension: string; kind: MediaKind };

/**
 * Returns the normalised type for an upload, or null if unsupported.
 * Browsers sometimes send application/octet-stream, so fall back to the
 * filename extension in that case.
 */
export function resolveUploadType(
  contentType: string | null | undefined,
  fileName: string | null | undefined,
): ResolvedUpload | null {
  const normalized = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (Object.hasOwn(SUPPORTED_UPLOAD_TYPES, normalized)) {
    return { contentType: normalized, extension: SUPPORTED_UPLOAD_TYPES[normalized], kind: mediaKindFor(normalized) };
  }
  if ((normalized === "" || normalized === "application/octet-stream") && fileName?.includes(".")) {
    const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    if (Object.hasOwn(EXTENSION_TO_TYPE, ext)) {
      const type = EXTENSION_TO_TYPE[ext];
      return { contentType: type, extension: ext, kind: mediaKindFor(type) };
    }
  }
  return null;
}

export function mediaKindFor(contentType: string): MediaKind {
  if (contentType.startsWith("image/")) return "IMAGE";
  if (contentType.startsWith("audio/")) return "AUDIO";
  return "VIDEO";
}

/** Accept attribute for a file input, per kind of media. */
export function acceptFor(kinds: MediaKind[]): string {
  return Object.keys(SUPPORTED_UPLOAD_TYPES)
    .filter((type) => kinds.includes(mediaKindFor(type)))
    .join(",");
}

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
