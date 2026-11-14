import sharp from "sharp";
import { CAMERA_KEYFRAME_MODEL, cameraKeyframeGenerateSchema, type CameraKeyframeGenerateInput, type CameraKeyframeInput, type CameraKeyframeJob, type CameraKeyframeStatus } from "@reelwalk/core";
import { prisma, keyframesEnabled, KeyframeError, keyframeHash, makeKeyframeRequest, reserveKeyframe, aiCreditSummary, type KeyframeSnapshot, type KeyframeSource, type AiKeyframe } from "@reelwalk/db";
import { mediaScope } from "./media-scope";
import { readKeyframeObject, putKeyframeObject } from "./storage";
import { storageBlockedReason } from "./quotas";
import { toLibraryAsset, type LibraryAsset } from "./library";

type Actor = { id: string; workspaceId: string; email?: string };
const url = (id: string, artifact: string) => `/api/ai/keyframes?job=${encodeURIComponent(id)}&artifact=${artifact}`;
export async function keyframeView(job: AiKeyframe): Promise<CameraKeyframeJob<LibraryAsset>> {
  const snapshot = job.snapshot as unknown as KeyframeSnapshot;
  const asset = job.assetId ? await prisma.mediaAsset.findFirst({ where: { id: job.assetId, workspaceId: job.workspaceId } }) : null;
  return { id: job.id, requestId: job.requestId, status: job.status as CameraKeyframeStatus, requestHash: job.requestHash, input: job.input as unknown as CameraKeyframeInput,
    sourceUrl: snapshot.source?.canonicalKey ? url(job.id, "source") : null, continuityUrl: snapshot.continuity ? url(job.id, "continuity") : null,
    candidateUrl: job.candidateKey ? url(job.id, "candidate") : null, asset: asset ? await toLibraryAsset(asset) : null,
    error: job.error, credits: 1, creditRefunded: job.creditRefunded, heldCostCents: job.heldCostCents, model: CAMERA_KEYFRAME_MODEL, createdAt: job.createdAt.toISOString() };
}
async function prepareSource(actor: Actor, assetId: string, prefix: string): Promise<{ snapshot: KeyframeSource; png: Buffer }> {
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, kind: "IMAGE", ...mediaScope(actor.workspaceId) } });
  if (!asset || !["image/jpeg", "image/png", "image/webp"].includes(asset.contentType) || asset.sizeBytes > 20n * 1024n * 1024n) throw new KeyframeError("Choose a JPEG, PNG or WebP photo under 20 MB from your library.", 404);
  const original = await readKeyframeObject(asset.objectKey, 20 * 1024 * 1024);
  const image = sharp(original, { limitInputPixels: 40_000_000, failOn: "warning" });
  const metadata = await image.metadata();
  if ((metadata.pages ?? 1) !== 1 || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new KeyframeError("Choose a still photograph.");
  const png = await image.rotate().resize(1080, 1920, { fit: "cover", position: "centre" }).png().toBuffer();
  const canonicalHash = keyframeHash(png), canonicalKey = `${prefix}/${canonicalHash}.png`;
  return { snapshot: { assetId, objectKey: asset.objectKey, originalHash: keyframeHash(original), canonicalKey, canonicalHash }, png };
}
export async function generateKeyframe(actor: Actor, value: CameraKeyframeGenerateInput) {
  const parsed = cameraKeyframeGenerateSchema.parse(value);
  const requestId = parsed.requestId;
  const input = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).strip().parse(parsed);
  if (actor.email === "demo@reelwalk.local") throw new KeyframeError("Create your own account to generate an image.", 403);
  const inputHash = keyframeHash(JSON.stringify(input));
  const existing = await prisma.aiKeyframe.findUnique({ where: { workspaceId_requestId: { workspaceId: actor.workspaceId, requestId } } });
  if (existing) {
    if (existing.inputHash !== inputHash) throw new KeyframeError("This saved request belongs to different frames or camera settings.");
    return keyframeView(existing);
  }
  if (!keyframesEnabled()) throw new KeyframeError("Image generation is paused. No credits used.", 403);
  const storageError = await storageBlockedReason(actor.workspaceId, 40 * 1024 * 1024, "A generated image");
  if (storageError) throw new KeyframeError(storageError);
  const prefix = `private/keyframes/${actor.workspaceId}/${requestId}`;
  const source = await prepareSource(actor, input.source.assetId, prefix);
  const continuity = input.continuity ? await prepareSource(actor, input.continuity.assetId, prefix) : null;
  const request = makeKeyframeRequest(input, source.png, continuity?.png);
  const requestHash = keyframeHash(request), requestKey = `${prefix}/${requestHash}.json`;
  const snapshot: KeyframeSnapshot = { model: CAMERA_KEYFRAME_MODEL, source: source.snapshot, ...(continuity ? { continuity: continuity.snapshot } : {}), requestKey,
    price: { inputPerMillion: 2, outputPerMillion: 120, inputTokenBound: 8192, outputTokenBound: 8192, maximumUsdMicros: 999424, evidence: "https://cloud.google.com/model-garden/pricing/" } };
  return keyframeView(await reserveKeyframe(prisma, actor, { requestId, input, inputHash, requestHash, snapshot }, new Date(), async () => {
    await putKeyframeObject(source.snapshot.canonicalKey, source.png, "image/png");
    if (continuity) await putKeyframeObject(continuity.snapshot.canonicalKey, continuity.png, "image/png");
    await putKeyframeObject(requestKey, Buffer.from(request), "application/json");
  }));
}
export async function listKeyframes(actor: Actor) {
  const [jobs, balance] = await Promise.all([prisma.aiKeyframe.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: 30 }), aiCreditSummary(prisma, actor.workspaceId)]);
  return { enabled: keyframesEnabled(), reason: keyframesEnabled() ? null : "Image generation is paused on this deployment.", balanceRemaining: balance.remaining, jobs: await Promise.all(jobs.map(keyframeView)) };
}
export async function keyframeArtifact(actor: Actor, id: string, artifact: "source" | "continuity" | "candidate") {
  const job = await prisma.aiKeyframe.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!job) throw new KeyframeError("Image unavailable.", 404);
  const snapshot = job.snapshot as unknown as KeyframeSnapshot;
  const key = artifact === "candidate" ? job.candidateKey : artifact === "source" ? snapshot.source.canonicalKey : snapshot.continuity?.canonicalKey;
  const digest = artifact === "candidate" ? job.candidateHash : artifact === "source" ? snapshot.source.canonicalHash : snapshot.continuity?.canonicalHash;
  if (!key) throw new KeyframeError("Image is not available yet.", 404);
  const bytes = await readKeyframeObject(key);
  if (keyframeHash(bytes) !== digest) throw new KeyframeError("Image pixels changed. This image cannot be used.");
  return { bytes, contentType: artifact === "candidate" ? "image/jpeg" : "image/png" };
}
/** A candidate becomes library media only after this explicit decision. No timeline is changed. */
export async function useKeyframe(actor: Actor, id: string) {
  const job = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "AiKeyframe" WHERE "id" = ${id} FOR UPDATE`;
    const row = await tx.aiKeyframe.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!row || !["CANDIDATE", "USED"].includes(row.status) || !row.candidateKey || !row.candidateHash) throw new KeyframeError("Choose a finished image from this workspace.", 404);
    if (row.status === "USED" && row.assetId) return row;
    const bytes = await readKeyframeObject(row.candidateKey);
    if (keyframeHash(bytes) !== row.candidateHash) throw new KeyframeError("Candidate pixels changed. The image cannot be used.");
    const input = row.input as unknown as CameraKeyframeInput;
    const asset = await tx.mediaAsset.create({ data: { workspaceId: actor.workspaceId, kind: "IMAGE", objectKey: row.candidateKey, thumbKey: row.candidateKey, previewKey: row.candidateKey,
      contentType: "image/jpeg", fileName: `AI ${input.role} frame ${row.id}.jpg`, sizeBytes: BigInt(bytes.length), width: 1080, height: 1920,
      attribution: `AI-generated concept keyframe; ${CAMERA_KEYFRAME_MODEL}; source ${input.source.assetId}; job ${row.id}; SHA256 ${row.candidateHash}; approximate camera intent, not surveyed geometry`, shared: false } });
    return tx.aiKeyframe.update({ where: { id }, data: { status: "USED", assetId: asset.id } });
  }, { timeout: 30_000 });
  const view = await keyframeView(job);
  return { job: view, asset: view.asset! };
}
