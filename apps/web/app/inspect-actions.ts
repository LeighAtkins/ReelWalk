"use server";

import { prisma } from "@reelwalk/db";
import { inspectOriginalUrl } from "@/lib/inspect-source";
import { presignedObjectUrl } from "@/lib/storage";
import { getCurrentUser } from "@/lib/workspace";

/** Inspect's Footage only (ADR 0057): a short-lived presigned URL of an asset's original file, for the signed-in studio. */
export async function inspectSource(input: { assetId: string }): Promise<{ url: string; expiresInSeconds: number } | null> {
  const user = await getCurrentUser();
  return inspectOriginalUrl({
    findAsset: (where) => prisma.mediaAsset.findFirst({ where: where as never, select: { objectKey: true, kind: true } }),
    presign: presignedObjectUrl,
  }, user.workspaceId, input?.assetId);
}
