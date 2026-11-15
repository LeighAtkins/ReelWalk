import sharp from "sharp";
import { CAMERA_KEYFRAME_MODEL, cameraKeyframeGenerateSchema, guidedKeyframeError, guidedPairEndInput, type CameraKeyframeGenerateInput, type CameraKeyframeInput, type CameraKeyframeJob, type CameraKeyframeStatus } from "@reelwalk/core";
import { prisma, keyframesEnabled, KeyframeError, keyframeHash, makeKeyframeRequest, reserveKeyframe, aiCreditSummary, type KeyframeSnapshot, type KeyframeSource, type AiKeyframe } from "@reelwalk/db";
import { mediaScope } from "./media-scope";
import { readKeyframeObject, putKeyframeObject } from "./storage";
import { storageBlockedReason } from "./quotas";
import { toLibraryAsset, type LibraryAsset } from "./library";

type Actor = { id: string; workspaceId: string; email?: string };
const url = (id: string, artifact: string) => `/api/ai/keyframes?job=${encodeURIComponent(id)}&artifact=${artifact}`;
const continuationPrefix = "End preparation paused: ";
export async function keyframeView(job: AiKeyframe): Promise<CameraKeyframeJob<LibraryAsset>> {
  const snapshot = job.snapshot as unknown as KeyframeSnapshot;
  const asset = job.assetId ? await prisma.mediaAsset.findFirst({ where: { id: job.assetId, workspaceId: job.workspaceId } }) : null;
  const continuationError = (job.input as unknown as CameraKeyframeInput).guidedPair && ["CANDIDATE", "USED"].includes(job.status) && job.error?.startsWith(continuationPrefix) ? job.error : null;
  return { id: job.id, requestId: job.requestId, status: job.status as CameraKeyframeStatus, requestHash: job.requestHash, input: job.input as unknown as CameraKeyframeInput,
    sourceUrl: snapshot.source?.canonicalKey ? url(job.id, "source") : null, continuityUrl: snapshot.continuity ? url(job.id, "continuity") : null,
    candidateUrl: job.candidateKey ? url(job.id, "candidate") : null, asset: asset ? await toLibraryAsset(asset) : null,
    error: continuationError ? null : job.error, continuationError, sourceFraming: snapshot.source?.normalization?.version === 2 ? "full-reference" : "portrait-crop",
    submittedAt: job.submittedAt?.toISOString() ?? null, credits: 1, creditRefunded: job.creditRefunded, heldCostCents: job.heldCostCents, model: CAMERA_KEYFRAME_MODEL, createdAt: job.createdAt.toISOString() };
}
/** Preserve the whole reference for new cinematic requests without expanding the old pixel/byte bounds. */
export async function normalizeKeyframeSource(original: Buffer, fullReference = false) {
  const image = sharp(original, { limitInputPixels: 40_000_000, failOn: "warning" });
  const metadata = await image.metadata();
  if ((metadata.pages ?? 1) !== 1 || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new KeyframeError("Choose a still photograph.");
  if (!fullReference) return { png: await image.rotate().resize(1080, 1920, { fit: "cover", position: "centre" }).png().toBuffer() };
  const swap = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const width = swap ? metadata.height : metadata.width, height = swap ? metadata.width : metadata.height;
  if (!width || !height) throw new KeyframeError("The source image dimensions are unavailable.");
  const scale = Math.min(1, 1920 / Math.max(width, height), Math.sqrt(1080 * 1920 / (width * height)));
  const result = await image.rotate().resize(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)), { fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  if (result.info.width * result.info.height > 1080 * 1920 || Math.max(result.info.width, result.info.height) > 1920 || result.data.length > 16 * 1024 * 1024) throw new KeyframeError("The full reference exceeds its bounded size.");
  return { png: result.data, normalization: { version: 2 as const, fit: "inside" as const, width: result.info.width, height: result.info.height } };
}
async function prepareSource(actor: Actor, assetId: string, prefix: string, fullReference = false): Promise<{ snapshot: KeyframeSource; png: Buffer }> {
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, kind: "IMAGE", ...mediaScope(actor.workspaceId) } });
  if (!asset || !["image/jpeg", "image/png", "image/webp"].includes(asset.contentType) || asset.sizeBytes > 20n * 1024n * 1024n) throw new KeyframeError("Choose a JPEG, PNG or WebP photo under 20 MB from your library.", 404);
  const original = await readKeyframeObject(asset.objectKey, 20 * 1024 * 1024);
  const { png, normalization } = await normalizeKeyframeSource(original, fullReference);
  const canonicalHash = keyframeHash(png), canonicalKey = `${prefix}/${canonicalHash}.png`;
  return { snapshot: { assetId, objectKey: asset.objectKey, originalHash: keyframeHash(original), canonicalKey, canonicalHash, ...(normalization ? { normalization } : {}) }, png };
}
export async function generateKeyframe(actor: Actor, value: CameraKeyframeGenerateInput, options: { expectedSource?: Pick<KeyframeSource, "objectKey" | "originalHash">; expectedContinuity?: Pick<KeyframeSource, "objectKey" | "originalHash"> } = {}) {
  const parsed = cameraKeyframeGenerateSchema.parse(value);
  const guidedError = guidedKeyframeError(parsed, parsed.requestId); if (guidedError) throw new KeyframeError(guidedError, 400);
  const requestId = parsed.requestId;
  const input = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).strip().parse(parsed);
  if (actor.email === "demo@reelwalk.local") throw new KeyframeError("Create your own account to generate an image.", 403);
  const inputHash = keyframeHash(JSON.stringify(input));
  const existing = await prisma.aiKeyframe.findUnique({ where: { workspaceId_requestId: { workspaceId: actor.workspaceId, requestId } } });
  if (existing) {
    if (existing.inputHash !== inputHash) throw new KeyframeError("This saved request belongs to different frames or camera settings.");
    const source = (existing.snapshot as unknown as KeyframeSnapshot).source;
    if (options.expectedSource && (source.objectKey !== options.expectedSource.objectKey || source.originalHash !== options.expectedSource.originalHash)) throw new KeyframeError("The original pair reference changed.");
    const continuity = (existing.snapshot as unknown as KeyframeSnapshot).continuity;
    if (options.expectedContinuity && (continuity?.objectKey !== options.expectedContinuity.objectKey || continuity?.originalHash !== options.expectedContinuity.originalHash)) throw new KeyframeError("The retained Start reference changed.");
    return keyframeView(existing);
  }
  if (!keyframesEnabled()) throw new KeyframeError("Image generation is paused. No credits used.", 403);
  const storageError = await storageBlockedReason(actor.workspaceId, 40 * 1024 * 1024, "A generated image");
  if (storageError) throw new KeyframeError(storageError);
  const prefix = `private/keyframes/${actor.workspaceId}/${requestId}`;
  const source = await prepareSource(actor, input.source.assetId, prefix, !!input.cinematography);
  if (options.expectedSource && (source.snapshot.objectKey !== options.expectedSource.objectKey || source.snapshot.originalHash !== options.expectedSource.originalHash)) throw new KeyframeError("The original pair reference changed.");
  const continuity = input.continuity ? await prepareSource(actor, input.continuity.assetId, prefix, !!input.cinematography) : null;
  if (options.expectedContinuity && (continuity?.snapshot.objectKey !== options.expectedContinuity.objectKey || continuity?.snapshot.originalHash !== options.expectedContinuity.originalHash)) throw new KeyframeError("The retained Start reference changed.");
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
export async function listKeyframes(actor: Actor, saved: { requestId?: string; jobId?: string } = {}) {
  const [jobs, balance] = await Promise.all([prisma.aiKeyframe.findMany({ where: { workspaceId: actor.workspaceId, ...(saved.requestId || saved.jobId ? { OR: [...(saved.requestId ? [{ requestId: saved.requestId }] : []), ...(saved.jobId ? [{ id: saved.jobId }] : [])] } : {}) }, orderBy: { createdAt: "desc" }, take: 30 }), aiCreditSummary(prisma, actor.workspaceId)]);
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
/** Retain a candidate after Use or Prepare Both. Retention is not creative acceptance; no timeline is changed. */
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

export const keyframePairServices = { db: prisma, read: readKeyframeObject, retain: useKeyframe, generate: generateKeyframe, view: keyframeView };
/** One Prepare Both decision authorizes this bounded continuation, not creative acceptance or video. */
export async function continueKeyframePair(actor: Actor, id: string, services = keyframePairServices) {
  if (!await services.db.user.findFirst({ where: { id: actor.id, OR: [{ workspaceId: actor.workspaceId }, { memberships: { some: { workspaceId: actor.workspaceId } } }] }, select: { id: true } })) throw new KeyframeError("This account no longer has access.", 403);
  const row = await services.db.aiKeyframe.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!row) throw new KeyframeError("The saved Start is unavailable.", 404);
  const parsed = cameraKeyframeGenerateSchema.parse({ ...(row.input as object), action: "generate", requestId: row.requestId });
  const error = guidedKeyframeError(parsed, row.requestId);
  if (error || !parsed.guidedPair) throw new KeyframeError(error || "Choose a saved guided Start.", 400);
  if (!["CANDIDATE", "USED"].includes(row.status)) throw new KeyframeError("Wait for the saved Start image. It will not be submitted again.");
  let endJob: CameraKeyframeJob<LibraryAsset> | null = null, continuationError: string | null = null;
  try {
    if (!keyframesEnabled() || (await services.db.workspace.findUnique({ where: { id: actor.workspaceId }, select: { aiGeneration: true } }))?.aiGeneration !== "on") throw new KeyframeError("Image generation is paused. Your Start is retained.", 403);
    const snapshot = row.snapshot as unknown as KeyframeSnapshot;
    const original = await services.db.mediaAsset.findFirst({ where: { id: parsed.source.assetId, objectKey: snapshot.source.objectKey, kind: "IMAGE", ...mediaScope(actor.workspaceId) } });
    if (!original || snapshot.source.assetId !== parsed.source.assetId || keyframeHash(await services.read(snapshot.source.objectKey, 20 * 1024 * 1024)) !== snapshot.source.originalHash) throw new KeyframeError("The original pair reference changed or is unavailable.");
    if (!row.candidateKey || !row.candidateHash || keyframeHash(await services.read(row.candidateKey, 16 * 1024 * 1024)) !== row.candidateHash) throw new KeyframeError("The saved Start pixels changed.");
    const retained = await services.retain(actor, row.id);
    endJob = await services.generate(actor, { action: "generate", requestId: parsed.guidedPair.endRequestId, ...guidedPairEndInput(parsed, retained.asset.id) }, { expectedSource: snapshot.source, expectedContinuity: { objectKey: row.candidateKey, originalHash: row.candidateHash } });
    await services.db.aiKeyframe.updateMany({ where: { id: row.id, workspaceId: actor.workspaceId, status: "USED" }, data: { error: null } });
  } catch (cause) {
    continuationError = continuationPrefix + (cause instanceof KeyframeError ? cause.message : "Your Start is retained. Check the saved End request before continuing.");
    await services.db.aiKeyframe.updateMany({ where: { id: row.id, workspaceId: actor.workspaceId, status: { in: ["CANDIDATE", "USED"] } }, data: { error: continuationError.slice(0, 300) } });
  }
  const current = await services.db.aiKeyframe.findFirst({ where: { id: row.id, workspaceId: actor.workspaceId } });
  if (!current) throw new KeyframeError("The saved pair is unavailable.", 404);
  return { job: await services.view(current), endJob, continuationError };
}
