import type { MediaKind } from "@reelwalk/core";
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
};

export async function toLibraryAsset(asset: {
  id: string;
  kind: MediaKind;
  fileName: string;
  objectKey: string;
  thumbKey: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}): Promise<LibraryAsset> {
  const [url, thumbUrl] = await Promise.all([mediaUrl(asset.objectKey), asset.thumbKey ? mediaUrl(asset.thumbKey) : null]);
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
  };
}
