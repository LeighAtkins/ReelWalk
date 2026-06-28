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
