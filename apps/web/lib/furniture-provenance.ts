import { prisma, KeyframeError, keyframeHash, type KeyframeSnapshot } from "@reelwalk/db";
import { readKeyframeObject } from "./storage";

export const furnitureProvenanceServices = { db: prisma, read: readKeyframeObject };

/** Shared library/video trust boundary; never infer provenance from a filename or browser draft. */
export async function furnitureDerivativeProvenance(asset: { id: string; workspaceId?: string; objectKey: string }, services = furnitureProvenanceServices) {
  if (!asset.workspaceId) return null;
  const prefix = `private/keyframes/${asset.workspaceId}/adjustments/`;
  if (!asset.objectKey.startsWith(prefix)) return null;
  const metadata = JSON.parse((await services.read(`${asset.objectKey}.json`, 8192)).toString("utf8"));
  const lineage = metadata.lineage;
  if (metadata.version !== 1 || metadata.assetId !== asset.id || metadata.workspaceId !== asset.workspaceId || metadata.objectKey !== asset.objectKey || lineage?.version !== 1 || lineage.compositor !== "furniture-v1" || !/^[a-f0-9]{64}$/.test(lineage.hash) || asset.objectKey !== `${prefix}${lineage.jobId}-${keyframeHash(JSON.stringify(lineage))}.jpg`) throw new KeyframeError("Adjusted keyframe identity changed.");
  const job = await services.db.aiKeyframe.findFirst({ where: { id: lineage.jobId, workspaceId: asset.workspaceId, status: { in: ["CANDIDATE", "USED"] } } });
  const snapshot = job?.snapshot as unknown as KeyframeSnapshot | undefined;
  const input = job?.input as { source?: { assetId?: string }; furnitureStage?: unknown } | undefined;
  if (!job || job.responseHash !== lineage.responseHash || snapshot?.source.canonicalHash !== lineage.sourceHash || !input?.furnitureStage || typeof input.source?.assetId !== "string") throw new KeyframeError("Adjusted keyframe lineage changed.");
  return { jobId: lineage.jobId as string, sourceAssetId: input.source.assetId, outputHash: lineage.hash as string, model: "gemini-3-pro-image" };
}
