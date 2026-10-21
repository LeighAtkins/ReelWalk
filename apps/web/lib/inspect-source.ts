import { mediaScope } from "./media-scope";

/**
 * The original file of an asset for Inspect's Footage only (ADR 0057),
 * asked for when it opens rather than sent with every library load: a
 * short-lived presigned S3 URL (never the CDN's unsigned one), for an asset
 * the studio may use. Kept free of Next and Prisma imports so it can be
 * tested with stand-ins (and loaded by the worker image, which copies lib).
 */

export type InspectSourceDeps = {
  findAsset(where: Record<string, unknown>): Promise<{ objectKey: string; kind: string } | null>;
  presign(objectKey: string, expiresIn: number): Promise<string>;
};

/** How long the URL works: long enough to step through a take, short enough not to be a share link. */
export const INSPECT_URL_SECONDS = 900;

export async function inspectOriginalUrl(deps: InspectSourceDeps, workspaceId: string, assetId: unknown): Promise<{ url: string; expiresInSeconds: number } | null> {
  if (typeof assetId !== "string" || !assetId || assetId.length > 100) return null;
  const asset = await deps.findAsset({ id: assetId, ...mediaScope(workspaceId) });
  if (!asset || (asset.kind !== "VIDEO" && asset.kind !== "IMAGE")) return null;
  return { url: await deps.presign(asset.objectKey, INSPECT_URL_SECONDS), expiresInSeconds: INSPECT_URL_SECONDS };
}
