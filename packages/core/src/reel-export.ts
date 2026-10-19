import { z } from "zod";
import { isInstagramMusic, referencedAssetIds, timelineSchema, type Timeline } from "./timeline";
import { transcriptSchema, type Transcript } from "./transcript";

/**
 * What a REEL render job carries in RenderJob.payload: the timeline as it was
 * when Export was pressed, and where each asset lives in storage. Edits made
 * after that do not change the video being rendered, and a retry renders the
 * same thing again.
 */
export const reelExportPayloadSchema = z.object({
  timeline: timelineSchema,
  // Decided by the plan when Export was pressed. Older payloads have none: full size, no mark.
  output: z
    .object({
      width: z.union([z.literal(720), z.literal(1080)]),
      watermark: z.boolean(),
    })
    .default({ width: 1080, watermark: false }),
  assets: z.record(
    z.string(),
    z.object({
      objectKey: z.string().min(1),
      kind: z.enum(["VIDEO", "IMAGE", "AUDIO"]),
      /**
       * A private copy of an Instagram sound (ADR 0019): kept in the payload so
       * the export screen knows which sound the reel was edited to, but never
       * handed to the renderer. Older payloads have none.
       */
      instagramAudio: z.boolean().optional(),
      /** Speech with word timings, so the render can duck the music under it. */
      transcript: transcriptSchema.nullable().optional(),
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
  library: { id: string; objectKey: string; kind: "VIDEO" | "IMAGE" | "AUDIO"; instagramAudioId?: string | null; transcript?: unknown }[],
  output: ReelExportPayload["output"] = { width: 1080, watermark: false },
): ReelExportPayload {
  const byId = new Map(library.map((asset) => [asset.id, asset]));
  const assets: ReelExportPayload["assets"] = {};
  for (const id of referencedAssetIds(timeline)) {
    const asset = byId.get(id);
    if (!asset) throw new Error("This reel uses media that no longer exists. Remove it and try again.");
    const transcript = asset.transcript ? transcriptSchema.safeParse(asset.transcript).data ?? null : null;
    assets[id] = { objectKey: asset.objectKey, kind: asset.kind, instagramAudio: Boolean(asset.instagramAudioId), ...(transcript ? { transcript } : {}) };
  }
  return { timeline, assets, output };
}

/** The asset id of the reel's Instagram sound, when its music is one (by the asset's own record or the timeline's). */
export function instagramSoundAssetId(payload: Pick<ReelExportPayload, "timeline" | "assets">): string | null {
  const music = payload.timeline.music;
  if (!music) return null;
  return payload.assets[music.assetId]?.instagramAudio || isInstagramMusic(music) ? music.assetId : null;
}

/**
 * What the renderer is given for a REEL job. Instagram's licensed audio is
 * never baked into the MP4 (ADR 0019): when the music is an Instagram sound
 * the reel renders with only its clips' own audio, and the sound's file is
 * not passed on at all, so nothing downstream can play it by mistake.
 */
export function reelRenderPlan(payload: Pick<ReelExportPayload, "timeline" | "assets">): {
  timeline: Timeline;
  assets: Record<string, { objectKey: string; kind: "VIDEO" | "IMAGE" | "AUDIO"; transcript?: Transcript | null }>;
} {
  const dropped = new Set(Object.entries(payload.assets).filter(([, asset]) => asset.instagramAudio).map(([id]) => id));
  const sound = instagramSoundAssetId(payload);
  if (sound) dropped.add(sound);
  const timeline = sound ? { ...payload.timeline, music: null } : payload.timeline;
  const used = new Set(referencedAssetIds(timeline));
  const assets: Record<string, { objectKey: string; kind: "VIDEO" | "IMAGE" | "AUDIO"; transcript?: Transcript | null }> = {};
  for (const [id, asset] of Object.entries(payload.assets)) {
    if (!dropped.has(id) && used.has(id)) assets[id] = { objectKey: asset.objectKey, kind: asset.kind, ...(asset.transcript ? { transcript: asset.transcript } : {}) };
  }
  return { timeline, assets };
}
