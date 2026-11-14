import sharp from "sharp";
import type { S3Client } from "@aws-sdk/client-s3";
import { CAMERA_KEYFRAME_MODEL, cameraKeyframeGenerateSchema } from "@reelwalk/core";
import { prisma, keyframeHash, keyframesEnabled, makeKeyframeRequest, failUnsubmittedKeyframe, refundRefusedKeyframe, type AiKeyframe, type KeyframeSnapshot } from "@reelwalk/db";
import { readKeyframeObject, putKeyframeObject } from "../../web/lib/storage";
import { keyframeTransport, type KeyframeReceipt } from "./vertex-keyframes";

export const keyframeWorkerServices = { db: prisma, read: readKeyframeObject, put: putKeyframeObject, transport: keyframeTransport, enabled: keyframesEnabled, failUnsubmitted: failUnsubmittedKeyframe, refundRefused: refundRefusedKeyframe };
export const keyframeReceiptKey = (job: Pick<AiKeyframe, "id" | "workspaceId" | "requestHash">) => `private/keyframes/${job.workspaceId}/receipts/${job.id}-${job.requestHash}.json`;

export async function checkedKeyframeRequest(job: AiKeyframe, read = readKeyframeObject) {
  const snapshot = job.snapshot as unknown as KeyframeSnapshot;
  if (snapshot.model !== CAMERA_KEYFRAME_MODEL || snapshot.price?.inputTokenBound !== 8192 || snapshot.price.outputTokenBound !== 8192 || snapshot.price.maximumUsdMicros !== 999424 || snapshot.price.inputPerMillion !== 2 || snapshot.price.outputPerMillion !== 120 || job.heldCostCents !== 100) throw new Error("Bounded exact image model and reservation required.");
  const parsed = cameraKeyframeGenerateSchema.parse({ ...(job.input as object), action: "generate", requestId: job.requestId });
  const input = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).strip().parse(parsed);
  for (const source of [snapshot.source, ...(snapshot.continuity ? [snapshot.continuity] : [])]) {
    if (keyframeHash(await read(source.objectKey, 20 * 1024 * 1024)) !== source.originalHash) throw new Error("Original source pixels changed.");
  }
  const source = await read(snapshot.source.canonicalKey);
  const continuity = snapshot.continuity ? await read(snapshot.continuity.canonicalKey) : undefined;
  if (keyframeHash(source) !== snapshot.source.canonicalHash || continuity && keyframeHash(continuity) !== snapshot.continuity!.canonicalHash) throw new Error("Frozen source pixels changed.");
  if (input.source.assetId !== snapshot.source.assetId || input.continuity?.assetId !== snapshot.continuity?.assetId || keyframeHash(JSON.stringify(input)) !== job.inputHash) throw new Error("Frozen source identity changed.");
  const request = (await read(snapshot.requestKey)).toString("utf8");
  if (keyframeHash(request) !== job.requestHash || makeKeyframeRequest(input, source, continuity) !== request) throw new Error("Frozen image request changed.");
  return request;
}

async function importReceipt(job: AiKeyframe, receipt: KeyframeReceipt, services: typeof keyframeWorkerServices) {
  if (receipt.version !== 1 || typeof receipt.bodyBase64 !== "string" || !Number.isInteger(receipt.status)) throw new Error("Invalid stored image receipt.");
  if (receipt.incomplete) {
    await services.db.aiKeyframe.updateMany({ where: { id: job.id, status: { in: ["SUBMITTING", "UNKNOWN"] } }, data: { status: "UNKNOWN", error: "An incomplete image response was retained. No automatic retry; its cost remains reserved." } });
    return;
  }
  if (receipt.status >= 400 && receipt.status <= 599) {
    await services.refundRefused(services.db, job.id, receipt.status);
    return;
  }
  let candidate: { jpeg: Buffer; hash: string; key: string };
  try {
    if (receipt.status < 200 || receipt.status >= 300) throw new Error(`Image service returned HTTP ${receipt.status}. Its response was retained; no automatic retry.`);
    const result = JSON.parse(Buffer.from(receipt.bodyBase64, "base64").toString("utf8")) as { candidates?: { content?: { parts?: { thought?: boolean; inlineData?: { mimeType?: string; data?: string } }[] } }[] };
    const images = (result.candidates ?? []).flatMap(candidate => candidate.content?.parts ?? []).flatMap(part => part.thought !== true && part.inlineData?.mimeType && ["image/png", "image/jpeg", "image/webp"].includes(part.inlineData.mimeType) && part.inlineData.data ? [part.inlineData] : []);
    if (images.length !== 1) throw new Error("Google did not return exactly one image. The raw response was retained; no automatic retry.");
    const raw = Buffer.from(images[0].data!, "base64");
    if (raw.length > 16 * 1024 * 1024) throw new Error("Generated image exceeds its size bound.");
    const image = sharp(raw, { limitInputPixels: 20_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1) throw new Error("Generated output is not a still image.");
    // This is the canonical frame shown in comparison and later delivered unchanged to Veo.
    const jpeg = await image.rotate().resize(1080, 1920, { fit: "cover", position: "centre" }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    const hash = keyframeHash(jpeg);
    candidate = { jpeg, hash, key: `private/keyframes/${job.workspaceId}/candidates/${job.id}-${hash}.jpg` };
  } catch (error) {
    await services.db.aiKeyframe.updateMany({ where: { id: job.id, status: { in: ["SUBMITTING", "UNKNOWN"] } }, data: { status: "FAILED", error: error instanceof Error ? error.message.slice(0, 300) : "Stored image could not be imported. The response and cost reservation were retained." } });
    return;
  }
  // Storage/DB outages remain recoverable from the paid receipt without another model call.
  await services.put(candidate.key, candidate.jpeg, "image/jpeg");
  await services.db.aiKeyframe.updateMany({ where: { id: job.id, status: { in: ["SUBMITTING", "UNKNOWN"] } }, data: { status: "CANDIDATE", candidateKey: candidate.key, candidateHash: candidate.hash, error: null } });
}
async function recoverReceipt(job: AiKeyframe, services: typeof keyframeWorkerServices) {
  const key = keyframeReceiptKey(job);
  try {
    // Receipt JSON contains base64 and can be larger than the bounded provider body.
    const bytes = await services.read(key, 34 * 1024 * 1024);
    if (job.responseHash && job.responseHash !== keyframeHash(bytes)) throw new Error("Stored image receipt changed.");
    await services.db.aiKeyframe.updateMany({ where: { id: job.id, status: { in: ["SUBMITTING", "UNKNOWN"] } }, data: { responseKey: key, responseHash: keyframeHash(bytes) } });
    await importReceipt(job, JSON.parse(bytes.toString("utf8")), services);
  } catch {
    await services.db.aiKeyframe.updateMany({ where: { id: job.id, status: { in: ["SUBMITTING", "UNKNOWN"] } }, data: { status: "UNKNOWN", error: "Image outcome is unknown. No automatic retry; its cost remains reserved." } });
  }
}
/** Durable one-dispatch boundary. Recovery never invokes a model. */
export async function processKeyframes(s3: Pick<S3Client, "config">, services = keyframeWorkerServices): Promise<boolean> {
  const stale = await services.db.aiKeyframe.findMany({ where: { OR: [{ status: "SUBMITTING", submittedAt: { lt: new Date(Date.now() - 180_000) } }, { status: "UNKNOWN", updatedAt: { lt: new Date(Date.now() - 60_000) } }] }, orderBy: { updatedAt: "asc" }, take: 5 });
  for (const job of stale) await recoverReceipt(job, services);
  // Receipt recovery never constitutes fresh queue demand or keeps an idle task alive.
  if (!services.enabled()) return false;
  const job = await services.db.aiKeyframe.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (!job) return false;
  let claimed = false;
  try {
    const request = await checkedKeyframeRequest(job, services.read);
    const transport = await services.transport(s3.config.credentials);
    claimed = await services.db.$transaction(async tx => {
      const workspace = await tx.workspace.findUnique({ where: { id: job.workspaceId }, select: { aiGeneration: true } });
      if (!services.enabled() || workspace?.aiGeneration !== "on") throw new Error("Image generation was paused before submission.");
      if (!await tx.user.findFirst({ where: { id: job.userId, OR: [{ workspaceId: job.workspaceId }, { memberships: { some: { workspaceId: job.workspaceId } } }] }, select: { id: true } })) throw new Error("Image requester no longer has workspace access.");
      const snapshot = job.snapshot as unknown as KeyframeSnapshot;
      for (const source of [snapshot.source, ...(snapshot.continuity ? [snapshot.continuity] : [])]) {
        if (!await tx.mediaAsset.findFirst({ where: { id: source.assetId, objectKey: source.objectKey, kind: "IMAGE", OR: [{ workspaceId: job.workspaceId }, { shared: true }], styleReference: { is: null } }, select: { id: true } })) throw new Error("Image source is no longer available to this workspace.");
      }
      return (await tx.aiKeyframe.updateMany({ where: { id: job.id, status: "QUEUED", submittedAt: null }, data: { status: "SUBMITTING", submittedAt: new Date() } })).count === 1;
    });
    if (!claimed) return true;
    const receipt = await transport.submit(request); // The only paid POST. Never dispatched a second time.
    const bytes = Buffer.from(JSON.stringify(receipt)), key = keyframeReceiptKey(job);
    await services.put(key, bytes, "application/json");
    await services.db.aiKeyframe.updateMany({ where: { id: job.id, status: "SUBMITTING" }, data: { responseKey: key, responseHash: keyframeHash(bytes) } });
    await importReceipt(job, receipt, services);
  } catch {
    if (claimed) await services.db.aiKeyframe.updateMany({ where: { id: job.id, status: "SUBMITTING" }, data: { status: "UNKNOWN", error: "Image outcome is unknown. No automatic retry; its cost remains reserved." } });
    else await services.failUnsubmitted(services.db, job.id, "Image validation or authentication failed before submission. No image generated; credit and cost hold released.");
  }
  return true;
}
