import { z } from "zod";
import { referencedAssetIds, timelineSchema, type Timeline } from "./timeline";

/**
 * What a REEL render job carries in RenderJob.payload: the timeline as it was
 * when Export was pressed, and where each asset lives in storage. Edits made
 * after that do not change the video being rendered, and a retry renders the
 * same thing again.
 */
export const reelExportPayloadSchema = z.object({
  timeline: timelineSchema,
  assets: z.record(
    z.string(),
    z.object({
      objectKey: z.string().min(1),
      kind: z.enum(["VIDEO", "IMAGE", "AUDIO"]),
    }),
  ),
});
export type ReelExportPayload = z.infer<typeof reelExportPayloadSchema>;

export function parseReelExportPayload(value: unknown): ReelExportPayload {
  const payload = reelExportPayloadSchema.parse(value);
  const missing = referencedAssetIds(payload.timeline).filter((id) => !payload.assets[id]);
  if (missing.length > 0) throw new Error(`Export is missing ${missing.length} media file(s)`);
  return payload;
}

/** Builds the payload, keeping only the assets the timeline uses. */
export function buildReelExportPayload(
  timeline: Timeline,
  library: { id: string; objectKey: string; kind: "VIDEO" | "IMAGE" | "AUDIO" }[],
): ReelExportPayload {
  const byId = new Map(library.map((asset) => [asset.id, asset]));
  const assets: ReelExportPayload["assets"] = {};
  for (const id of referencedAssetIds(timeline)) {
    const asset = byId.get(id);
    if (!asset) throw new Error("This reel uses media that no longer exists. Remove it and try again.");
    assets[id] = { objectKey: asset.objectKey, kind: asset.kind };
  }
  return { timeline, assets };
}
