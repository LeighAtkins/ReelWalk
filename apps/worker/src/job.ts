export type RenderJobPayload = {
  jobId: string;
  listingId: string;
  inputKey: string;
  /** "editor" for timeline project renders, undefined for legacy stub renders */
  type?: string;
};

export function parseRenderJobPayload(raw: string): RenderJobPayload {
  const parsed = JSON.parse(raw) as Partial<RenderJobPayload>;
  if (!parsed.jobId || !parsed.listingId || !parsed.inputKey) {
    throw new Error("Invalid render job payload");
  }
  return {
    jobId: parsed.jobId,
    listingId: parsed.listingId,
    inputKey: parsed.inputKey,
    type: parsed.type,
  };
}

export function outputKeyFor(job: RenderJobPayload): string {
  return `renders/${job.listingId}/${job.jobId}.mp4`;
}

const KNOWN_INPUT_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "jpg", "jpeg", "png", "webp"]);

/**
 * Local filename for the downloaded input. The extension is preserved from the
 * S3 key so the Remotion composition can tell images from videos; anything
 * unrecognised falls back to .mp4 (the historical behaviour).
 */
export function inputFilenameFor(job: Pick<RenderJobPayload, "inputKey">): string {
  const match = /\.([a-z0-9]+)$/i.exec(job.inputKey);
  const ext = match ? match[1].toLowerCase() : "";
  return `input.${KNOWN_INPUT_EXTENSIONS.has(ext) ? ext : "mp4"}`;
}
