import { randomUUID } from "node:crypto";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@reelwalk/db";
import { PRESENTER_CROP_GAVE_UP, PRESENTER_CROP_MAX_TRIES } from "@reelwalk/core";
import { decodeFrame, pngSize } from "./ai-frames";
import { cropFacePng, faceCropRect } from "./identity";
import { VertexImages } from "./vertex-images";

let images: VertexImages | undefined;

/**
 * Where one face crop is stored: per kit, per portrait, per attempt. A key is
 * written once and never overwritten, so a generation that snapshotted it at
 * reserve time always reads the bytes it was promised (ADR 0056).
 */
export const faceCropKey = (workspaceId: string, presenterId: string, portraitAssetId: string, version: string) =>
  `workspaces/${workspaceId}/presenters/${presenterId}/${portraitAssetId}/${version}.png`;

/**
 * Make one waiting presenter kit's face crop (ADR 0056): find her face in
 * the portrait, cut a square around it with the hairline and hair, and store
 * a 768×768 PNG. The claim carries a token and the portrait it was taken
 * for; the crop is published only if both still hold, so a portrait replaced
 * mid-crop never gets the old face.
 */
export async function processPresenterKit(s3: S3Client, bucket: string, now = new Date()): Promise<boolean> {
  // A worker that died on the last try leaves a lapsed claim with the tries used up: settle it so the kit says so.
  const settled = await prisma.presenter.updateMany({
    where: { faceCropKey: null, faceCropError: null, faceCropTries: { gte: PRESENTER_CROP_MAX_TRIES }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { faceCropError: PRESENTER_CROP_GAVE_UP, leaseToken: null, leaseUntil: null },
  });
  const waiting = await prisma.presenter.findFirst({
    where: { faceCropKey: null, faceCropError: null, faceCropTries: { lt: PRESENTER_CROP_MAX_TRIES }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    orderBy: { createdAt: "asc" },
  });
  if (!waiting) return settled.count > 0;
  const token = randomUUID();
  const claimed = await prisma.presenter.updateMany({
    where: { id: waiting.id, portraitAssetId: waiting.portraitAssetId, faceCropKey: null, faceCropError: null, faceCropTries: waiting.faceCropTries, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseToken: token, leaseUntil: new Date(now.getTime() + 5 * 60_000), faceCropTries: { increment: 1 } },
  });
  if (!claimed.count) return true;
  // Every write below is conditional on this: the same portrait, this claim, no crop yet.
  const ours = { id: waiting.id, portraitAssetId: waiting.portraitAssetId, leaseToken: token, faceCropKey: null };
  const settle = (data: { faceCropError?: string }) => prisma.presenter.updateMany({ where: ours, data: { ...data, leaseToken: null, leaseUntil: null } });
  const portrait = await prisma.mediaAsset.findFirst({ where: { id: waiting.portraitAssetId, workspaceId: waiting.workspaceId, kind: "IMAGE" }, select: { objectKey: true } });
  if (!portrait) {
    await settle({ faceCropError: "The portrait is no longer in your library. Choose another." });
    return true;
  }
  try {
    const png = await decodeFrame(s3, bucket, portrait.objectKey, 0, "reference-png");
    const { width, height } = pngSize(png);
    images ??= new VertexImages(undefined, undefined, s3.config.credentials);
    const box = await images.findFace({ bytesBase64Encoded: png.toString("base64"), mimeType: "image/png" });
    if (!box || box[2] <= box[0] || box[3] <= box[1]) {
      await settle({ faceCropError: "No clear face was found in the portrait. Choose a head-and-shoulders photo facing the camera." });
      return true;
    }
    const rect = faceCropRect(box, width, height);
    const crop = await cropFacePng(png, rect);
    const key = faceCropKey(waiting.workspaceId, waiting.id, waiting.portraitAssetId, token);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: crop, ContentType: "image/png" }));
    // Measured in the decoded portrait (the photo itself, or scaled down to fit 1080×1920).
    const published = await prisma.presenter.updateMany({ where: ours, data: { faceCropKey: key, faceHeightPx: rect.faceHeightPx, leaseToken: null, leaseUntil: null } });
    console.log(published.count
      ? `presenter: ${waiting.id}: face crop made, face ${rect.faceHeightPx} px tall in the portrait`
      : `presenter: ${waiting.id}: the kit changed while its face was cut; the crop was not used`);
  } catch (error) {
    console.error(`presenter: ${waiting.id}: face crop failed: ${error instanceof Error ? error.message : "unknown"}`);
    await settle(waiting.faceCropTries + 1 >= PRESENTER_CROP_MAX_TRIES ? { faceCropError: PRESENTER_CROP_GAVE_UP } : {});
  }
  return true;
}
