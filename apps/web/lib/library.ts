import { isEquirect, spotSchema, type MediaKind, type Spot } from "@reelwalk/core";
import { mediaUrl } from "./storage";

/** A media asset as the editor sees it: what it is and where the browser can load it. */
export type LibraryAsset = {
  id: string;
  kind: MediaKind;
  fileName: string;
  url: string;
  thumbUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** A 360 photo (2:1 equirectangular image). */
  isPano: boolean;
  /** "Poly Haven, CC0 1.0" for imported library media; null for your own uploads. */
  credit: string | null;
  /** Set when the shot belongs to a home tour with a floor plan. */
  tourId: string | null;
  spot: Spot | null;
  room: string | null;
  /** For music: tempo and first beat, when detected. */
  bpm: number | null;
  beatOffsetMs: number | null;
};

export async function toLibraryAsset(asset: {
  id: string;
  kind: MediaKind;
  fileName: string;
  objectKey: string;
  thumbKey: string | null;
  /** Set once a worker has made the 720p preview rendition. */
  previewKey?: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  license?: string | null;
  attribution?: string | null;
  tourId?: string | null;
  spot?: unknown;
  room?: string | null;
  bpm?: number | null;
  beatOffsetMs?: number | null;
}): Promise<LibraryAsset> {
  const spot = spotSchema.safeParse(asset.spot);
  // The editor plays the light preview rendition when one exists; exports always use the original.
  const [url, thumbUrl] = await Promise.all([mediaUrl(asset.previewKey ?? asset.objectKey), asset.thumbKey ? mediaUrl(asset.thumbKey) : null]);
  return {
    id: asset.id,
    kind: asset.kind,
    fileName: asset.fileName,
    url,
    // A photo is its own thumbnail.
    thumbUrl: thumbUrl ?? (asset.kind === "IMAGE" ? url : null),
    durationMs: asset.durationMs,
    width: asset.width,
    height: asset.height,
    isPano: asset.kind === "IMAGE" && isEquirect(asset.width, asset.height),
    credit: asset.attribution ? [asset.attribution, asset.license].filter(Boolean).join(", ") : null,
    tourId: asset.tourId ?? null,
    spot: spot.success ? spot.data : null,
    room: asset.room ?? null,
    bpm: asset.bpm ?? null,
    beatOffsetMs: asset.beatOffsetMs ?? null,
  };
}
