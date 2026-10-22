import sharp from "sharp";
import { colorStatsFromRgba, matchableClips, type ColorStats, type Timeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { mediaScope } from "@/lib/media-scope";
import { readObject } from "@/lib/storage";

/**
 * Colour statistics of a reel's clips measured on the server (ADR 0070), for
 * `POST /api/reels/:id/look`, so an agent can match a look over HTTP. The web
 * image cannot decode video, so each clip is measured on its asset's poster
 * (the thumbnail the browser made at upload, or the stock site's poster): one
 * frame, not the three the editor reads, which the response says. A photo is
 * measured on itself. Clips of the same asset share one measurement.
 */
export type ServerMeasurement = { stats: Record<string, ColorStats>; framesPerClip: 1; unmeasured: string[] };

export async function measureReelLook(workspaceId: string, timeline: Timeline): Promise<ServerMeasurement> {
  const clips = matchableClips(timeline);
  const assetIds = [...new Set(clips.map((clip) => clip.assetId))];
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: assetIds }, ...mediaScope(workspaceId) }, select: { id: true, kind: true, thumbKey: true, objectKey: true, contentType: true } });
  const byAsset = new Map<string, ColorStats | null>();
  await Promise.all(assets.map(async (asset) => {
    const key = asset.thumbKey ?? (asset.kind === "IMAGE" ? asset.objectKey : null);
    byAsset.set(asset.id, key ? await measureObject(key).catch(() => null) : null);
  }));
  const stats: Record<string, ColorStats> = {};
  const unmeasured: string[] = [];
  for (const clip of clips) {
    const measured = byAsset.get(clip.assetId);
    if (measured) stats[clip.id] = measured;
    else unmeasured.push(clip.id);
  }
  return { stats, framesPerClip: 1, unmeasured };
}

/** The statistics of one stored picture, decoded small (the statistics are means and spreads; 160 px across is plenty). */
export async function measureObject(objectKey: string): Promise<ColorStats | null> {
  const object = await readObject(objectKey, 24 * 1024 * 1024);
  if (!object) return null;
  const { data, info } = await sharp(object.bytes).rotate().resize({ width: 160, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return colorStatsFromRgba(data, info.width, info.height);
}
