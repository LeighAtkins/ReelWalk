import { finalFurnitureImage } from "./furniture-receipt";
import sharp from "sharp";
import { furnitureStageSchema, type CameraKeyframeInput } from "@reelwalk/core";
import { prisma, KeyframeError, keyframeHash, keyframeStorageTransaction, type KeyframeSnapshot } from "@reelwalk/db";
import { readKeyframeObject, putKeyframeObject } from "./storage";
import { compositeFurnitureStage } from "./furniture-compositor";
import { storageBlockedReason } from "./quotas";
import { toLibraryAsset } from "./library";
import { furnitureDerivativeProvenance } from "./furniture-provenance";

type Actor = { id: string; workspaceId: string };
export const furnitureAdjustmentServices = { db: prisma, read: readKeyframeObject, put: putKeyframeObject, transaction: keyframeStorageTransaction, quota: storageBlockedReason, view: toLibraryAsset };
export async function adjustFurnitureArea(actor: Actor, jobId: string, region: unknown, previewHash?: string, services = furnitureAdjustmentServices) {
  const prepare = async (db: Pick<typeof prisma, "user" | "aiKeyframe">) => {
    if (!await db.user.findFirst({ where: { id: actor.id, OR: [{ workspaceId: actor.workspaceId }, { memberships: { some: { workspaceId: actor.workspaceId } } }] }, select: { id: true } })) throw new KeyframeError("Account unavailable.", 403);
    const job = await db.aiKeyframe.findFirst({ where: { id: jobId, workspaceId: actor.workspaceId, status: { in: ["CANDIDATE", "USED"] } } });
    if (!job || !job.responseKey || !job.responseHash) throw new KeyframeError("Saved furniture result unavailable.", 404);
    const input = job.input as unknown as CameraKeyframeInput;
    if (!input.furnitureStage) throw new KeyframeError("Choose a furniture result.");
    const stage = furnitureStageSchema.parse({ ...input.furnitureStage, region });
    const snapshot = job.snapshot as unknown as KeyframeSnapshot;
    const source = await services.read(snapshot.source.canonicalKey, 16 * 1024 * 1024);
    const receipt = await services.read(job.responseKey, 34 * 1024 * 1024);
    if (keyframeHash(source) !== snapshot.source.canonicalHash || keyframeHash(receipt) !== job.responseHash) throw new KeyframeError("Saved source or response changed.");
    const raw = finalFurnitureImage(receipt);
    const metadata = await sharp(raw, { limitInputPixels: 20_000_000, failOn: "warning" }).metadata();
    if ((metadata.pages ?? 1) !== 1) throw new KeyframeError("Choose a still image.");
    const bytes = await sharp(await compositeFurnitureStage(source, raw, stage)).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    const hash = keyframeHash(bytes);
    const lineage = { version: 1, jobId, sourceHash: snapshot.source.canonicalHash, responseHash: job.responseHash, region: stage.region, compositor: "furniture-v1", hash };
    return { bytes, hash, lineage, input: { ...input, furnitureStage: stage } };
  };
  if (previewHash === undefined) return prepare(services.db);
  return services.transaction(services.db, [actor.workspaceId], async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${actor.workspaceId} FOR UPDATE`;
    const result = await prepare(tx);
    if (result.hash !== previewHash) throw new KeyframeError("Preview changed. Preview the area again.");
    const identity = keyframeHash(JSON.stringify(result.lineage));
    const objectKey = `private/keyframes/${actor.workspaceId}/adjustments/${jobId}-${identity}.jpg`;
    let asset = await tx.mediaAsset.findFirst({ where: { workspaceId: actor.workspaceId, objectKey } });
    if (!asset) {
      const blocked = await services.quota(actor.workspaceId, result.bytes.length, "An adjusted concept");
      if (blocked) throw new KeyframeError(blocked);
      await services.put(objectKey, result.bytes, "image/jpeg");
      // Object writes survive DB rollback; retries must retain the sidecar's asset identity.
      const assetId = `fadj_${Buffer.from(keyframeHash(objectKey), "hex").toString("base64url")}`;
      asset = await tx.mediaAsset.create({ data: { id: assetId, workspaceId: actor.workspaceId, kind: "IMAGE", objectKey, thumbKey: objectKey, previewKey: objectKey, contentType: "image/jpeg", fileName: `Adjusted furniture concept ${jobId}.jpg`, sizeBytes: BigInt(result.bytes.length), width: 1080, height: 1920, shared: false, attribution: `AI furniture concept; not current furnishings or verified architecture. ${JSON.stringify(result.lineage)}` } });
    }
    await services.put(`${objectKey}.json`, Buffer.from(JSON.stringify({ version: 1, assetId: asset.id, objectKey, workspaceId: actor.workspaceId, lineage: result.lineage })), "application/json");
    return { ...result, asset: await services.view(asset) };
  });
}

/** Private immutable sidecar, written only by save; never accept browser draft hashes. */
export async function furnitureDerivativeKeyframe(asset: { id: string; workspaceId: string; objectKey: string }, services = furnitureAdjustmentServices) {
  const provenance = await furnitureDerivativeProvenance(asset, services);
  return provenance ? { id: provenance.jobId, candidateKey: asset.objectKey, candidateHash: provenance.outputHash } : null;
}
