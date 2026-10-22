import { colorStatsFromRgba, lookSampleMs, matchableClips, mergeColorStats, type ColorStats, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { loadImage, loadVideo, releaseVideo, seekVideo } from "./frame-service";

/**
 * Colour statistics of a reel's clips, measured in the browser (ADR 0070):
 * three frames of each video clip's window and a photo's one, drawn small
 * from the source itself (no fit, zoom or grade: the match is fitted to the
 * footage, and the grade sits on top). Sources are opened once each and
 * freed after; a clip whose media cannot be read is reported, not thrown.
 */
export type LookMeasurement = { stats: Record<string, ColorStats>; unmeasured: string[] };

/** The sample's longer side, px: means and spreads of 96×170 pixels are within a thousandth of the full frame's. */
const SAMPLE_SIDE = 170;

export async function measureLook(
  timeline: Timeline,
  library: Record<string, Pick<LibraryAsset, "id" | "url" | "kind">>,
  onProgress?: (done: number, total: number) => void,
): Promise<LookMeasurement> {
  const clips = matchableClips(timeline).filter((clip) => library[clip.assetId]);
  const byAsset = new Map<string, typeof clips>();
  for (const clip of clips) byAsset.set(clip.assetId, [...(byAsset.get(clip.assetId) ?? []), clip]);
  const stats: Record<string, ColorStats> = {};
  const unmeasured: string[] = [];
  let done = 0;
  for (const [assetId, own] of byAsset) {
    const asset = library[assetId];
    try {
      if (asset.kind === "IMAGE") {
        const image = await loadImage(asset.url);
        const measured = frameStats(image, image.naturalWidth, image.naturalHeight);
        for (const clip of own) {
          if (measured) stats[clip.id] = measured;
          else unmeasured.push(clip.id);
        }
      } else {
        const video = await loadVideo(asset.url);
        try {
          for (const clip of own) {
            const frames: ColorStats[] = [];
            for (const ms of lookSampleMs(clip)) {
              await seekVideo(video, Math.max(0, Math.min(ms, video.duration * 1000 - 20)));
              const measured = frameStats(video, video.videoWidth, video.videoHeight);
              if (measured) frames.push(measured);
            }
            const pooled = mergeColorStats(frames);
            if (pooled) stats[clip.id] = pooled;
            else unmeasured.push(clip.id);
          }
        } finally {
          releaseVideo(video);
        }
      }
    } catch {
      unmeasured.push(...own.map((clip) => clip.id));
    }
    done += own.length;
    onProgress?.(done, clips.length);
  }
  return { stats, unmeasured };
}

function frameStats(media: CanvasImageSource, sourceWidth: number, sourceHeight: number): ColorStats | null {
  if (!sourceWidth || !sourceHeight) return null;
  const scale = SAMPLE_SIDE / Math.max(sourceWidth, sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(media, 0, 0, width, height);
  try {
    const stats = colorStatsFromRgba(ctx.getImageData(0, 0, width, height).data, width, height);
    return stats.std.some((value) => value > 0) || stats.mean.some((value) => value !== 0) ? stats : null;
  } catch {
    // A tainted canvas (media without CORS headers) cannot be read back.
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
