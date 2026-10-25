import { randomUUID } from "node:crypto";
import { DEFAULT_IMAGE_MS, DEFAULT_PANO, DEFAULT_PANO_MS, type Clip, type Spot } from "@reelwalk/core";

/** What a clip needs to know about its library asset. */
export type ClipSource = { id: string; kind: "VIDEO" | "IMAGE" | "AUDIO"; durationMs: number | null; isPano: boolean; spot: Spot | null; room: string | null };

/**
 * A clip for a library photo or video, with the editor's own defaults (ADR
 * 0077): a photo gets three seconds and a slow push-in, a 360 photo five and
 * a sweep, a video plays whole. The editor's version lives in its client
 * component; the connector builds the same clip on the server.
 */
export function clipForAsset(asset: ClipSource, newId: () => string = randomUUID): Clip {
  const isImage = asset.kind === "IMAGE";
  return {
    id: newId(),
    assetId: asset.id,
    kind: isImage ? "IMAGE" : "VIDEO",
    sourceStartMs: 0,
    sourceEndMs: asset.isPano ? DEFAULT_PANO_MS : isImage ? DEFAULT_IMAGE_MS : Math.max(500, asset.durationMs ?? 5000),
    speed: 1,
    volume: 1,
    zoom: 1,
    fit: "cover",
    filter: "none",
    motion: isImage && !asset.isPano ? "zoom-in" : "none",
    transitionIn: "cut",
    pano: asset.isPano ? DEFAULT_PANO : null,
    spot: asset.spot,
    room: asset.room,
  };
}
