import { emptyTimeline, timelineDurationMs, timelineSchema, type Timeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { mediaUrl } from "./storage";

/**
 * Reads a stored timeline. A row that no longer matches the schema (an older
 * format, a manual edit) opens as an empty reel instead of crashing the page.
 */
export function readTimeline(value: unknown): Timeline {
  const parsed = timelineSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyTimeline();
}

/** Thumbnail of a reel's first clip, for lists. */
export async function coverUrls(timelines: Timeline[]): Promise<(string | null)[]> {
  const firstIds = timelines.map((timeline) => timeline.clips[0]?.assetId ?? null);
  const ids = [...new Set(firstIds.filter((id): id is string => id !== null))];
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: ids } },
    select: { id: true, kind: true, objectKey: true, thumbKey: true },
  });
  const urls = new Map(
    await Promise.all(
      assets.map(async (asset) => {
        const key = asset.thumbKey ?? (asset.kind === "IMAGE" ? asset.objectKey : null);
        return [asset.id, key ? await mediaUrl(key) : null] as const;
      }),
    ),
  );
  return firstIds.map((id) => (id ? (urls.get(id) ?? null) : null));
}

export function durationOf(timeline: Timeline): number {
  return timelineDurationMs(timeline);
}
