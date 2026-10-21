import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@reelwalk/db";
import { decodeFrame, isPng, pngSize } from "./ai-frames";
import { faceCropArguments, faceCropRect } from "./identity";
import { VertexImages } from "./vertex-images";

const run = promisify(execFile);
const MAX_TRIES = 3;
let images: VertexImages | undefined;

/** Where a kit's face crop is stored: beside the workspace's AI takes. */
export const faceCropKey = (workspaceId: string, presenterId: string) => `workspaces/${workspaceId}/presenters/${presenterId}/face.png`;

/**
 * Make one waiting presenter kit's face crop (ADR 0056): find her face in
 * the portrait, cut a square around it with the hairline and hair, and store
 * a 768×768 PNG. Leased like an AI generation so two workers never race.
 */
export async function processPresenterKit(s3: S3Client, bucket: string, now = new Date()): Promise<boolean> {
  const waiting = await prisma.presenter.findFirst({
    where: { faceCropKey: null, faceCropError: null, faceCropTries: { lt: MAX_TRIES }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    orderBy: { createdAt: "asc" },
  });
  if (!waiting) return false;
  const leaseUntil = new Date(now.getTime() + 5 * 60_000);
  const claimed = await prisma.presenter.updateMany({
    where: { id: waiting.id, faceCropKey: null, faceCropTries: waiting.faceCropTries, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil, faceCropTries: { increment: 1 } },
  });
  if (!claimed.count) return true;
  const portrait = await prisma.mediaAsset.findFirst({ where: { id: waiting.portraitAssetId, workspaceId: waiting.workspaceId, kind: "IMAGE" }, select: { objectKey: true } });
  if (!portrait) {
    await prisma.presenter.update({ where: { id: waiting.id }, data: { faceCropError: "The portrait is no longer in your library. Choose another.", leaseUntil: null } });
    return true;
  }
  const workdir = await mkdtemp(path.join(os.tmpdir(), `presenter-${waiting.id}-`));
  try {
    const png = await decodeFrame(s3, bucket, portrait.objectKey, 0, "reference-png");
    const { width, height } = pngSize(png);
    images ??= new VertexImages(undefined, undefined, s3.config.credentials);
    const box = await images.findFace({ bytesBase64Encoded: png.toString("base64"), mimeType: "image/png" });
    if (!box || box[2] <= box[0] || box[3] <= box[1]) {
      await prisma.presenter.update({ where: { id: waiting.id }, data: { faceCropError: "No clear face was found in the portrait. Choose a head-and-shoulders photo facing the camera.", leaseUntil: null } });
      return true;
    }
    const rect = faceCropRect(box, width, height);
    const input = path.join(workdir, "portrait.png");
    await writeFile(input, png);
    const { stdout } = await run("ffmpeg", faceCropArguments(input, rect), { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true }) as unknown as { stdout: Buffer };
    if (!isPng(stdout)) throw new Error("The face crop could not be encoded.");
    const key = faceCropKey(waiting.workspaceId, waiting.id);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: stdout, ContentType: "image/png" }));
    // Measured in the decoded portrait (the photo itself, or scaled down to fit 1080×1920).
    await prisma.presenter.update({ where: { id: waiting.id }, data: { faceCropKey: key, faceHeightPx: rect.faceHeightPx, leaseUntil: null } });
    console.log(`presenter: ${waiting.id}: face crop made, face ${rect.faceHeightPx} px tall in the portrait`);
  } catch (error) {
    console.error(`presenter: ${waiting.id}: face crop failed: ${error instanceof Error ? error.message : "unknown"}`);
    await prisma.presenter.update({ where: { id: waiting.id }, data: {
      leaseUntil: null,
      ...(waiting.faceCropTries + 1 >= MAX_TRIES ? { faceCropError: "Her face reference could not be made. Choose another portrait to retry." } : {}),
    } });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
  return true;
}
