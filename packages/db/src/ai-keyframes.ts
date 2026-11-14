import { createHash } from "node:crypto";
import { CAMERA_KEYFRAME_HOLD_CENTS, CAMERA_KEYFRAME_MODEL, cameraKeyframePrompt, type CameraKeyframeInput } from "@reelwalk/core";
import { lockBillingAccount, AiCreditError } from "./ai-credits";
import { keyframeStorageTransaction } from "./keyframe-storage";
import type { Prisma, PrismaClient } from "./generated/prisma/client";

export const keyframeHash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
/** One frozen, bounded request; no tool/history/system messages or other model routes. */
export function makeKeyframeRequest(input: CameraKeyframeInput, source: Buffer, continuity?: Buffer): string {
  const text = cameraKeyframePrompt(input);
  if (Buffer.byteLength(text) > 4096) throw new KeyframeError("Image directions are too long.");
  for (const png of [source, ...(continuity ? [continuity] : [])]) if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.length > 16 * 1024 * 1024) throw new KeyframeError("Invalid bounded image reference.");
  const request = JSON.stringify({ contents: [{ role: "user", parts: [
    { inlineData: { mimeType: "image/png", data: source.toString("base64") } },
    ...(continuity ? [{ inlineData: { mimeType: "image/png", data: continuity.toString("base64") } }] : []), { text },
  ] }], generationConfig: { candidateCount: 1, responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "9:16", imageSize: "2K" }, maxOutputTokens: 8192 } });
  if (Buffer.byteLength(request) > 24 * 1024 * 1024) throw new KeyframeError("Image references are too large.");
  return request;
}
export type KeyframeSource = { assetId: string; objectKey: string; originalHash: string; canonicalKey: string; canonicalHash: string };
export type KeyframeSnapshot = {
  model: typeof CAMERA_KEYFRAME_MODEL; source: KeyframeSource; continuity?: KeyframeSource;
  requestKey: string; price: { inputPerMillion: 2; outputPerMillion: 120; inputTokenBound: 8192; outputTokenBound: 8192; maximumUsdMicros: 999424; evidence: string };
};
export class KeyframeError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
export function keyframesEnabled() { return process.env.AI_KEYFRAMES_ENABLED === "true" && Boolean(process.env.GOOGLE_CLOUD_PROJECT); }
export function assertSameKeyframe(existing: { inputHash: string; requestHash: string }, inputHash: string, requestHash: string) {
  if (existing.inputHash !== inputHash || existing.requestHash !== requestHash) throw new KeyframeError("This request identifier belongs to different frames or camera settings. Start a new image request.");
}
export async function reserveKeyframe(db: PrismaClient, actor: { id: string; workspaceId: string }, value: {
  requestId: string; input: CameraKeyframeInput; inputHash: string; requestHash: string; snapshot: KeyframeSnapshot;
}, now = new Date(), persist?: () => Promise<void>) {
  return keyframeStorageTransaction(db, [actor.workspaceId], async tx => {
    const account = await lockBillingAccount(tx, actor.workspaceId, now);
    if (!await tx.user.findFirst({ where: { id: actor.id, OR: [{ workspaceId: actor.workspaceId }, { memberships: { some: { workspaceId: actor.workspaceId } } }] }, select: { id: true } })) throw new KeyframeError("This account no longer has access.", 403);
    const existing = await tx.aiKeyframe.findUnique({ where: { workspaceId_requestId: { workspaceId: actor.workspaceId, requestId: value.requestId } } });
    if (existing) { assertSameKeyframe(existing, value.inputHash, value.requestHash); return existing; }
    if (!keyframesEnabled() || account.aiGeneration !== "on") throw new KeyframeError("Image generation is paused. No credits used.", 403);
    for (const source of [value.snapshot.source, ...(value.snapshot.continuity ? [value.snapshot.continuity] : [])]) {
      const asset = await tx.mediaAsset.findFirst({ where: { id: source.assetId, objectKey: source.objectKey, kind: "IMAGE", OR: [{ workspaceId: actor.workspaceId }, { shared: true }], styleReference: { is: null } }, select: { id: true } });
      if (!asset) throw new KeyframeError("A source photo changed or is no longer in this workspace.");
    }
    if (await tx.aiKeyframe.count({ where: { workspaceId: actor.workspaceId, status: { in: ["QUEUED", "SUBMITTING"] } } }) >= 4) throw new KeyframeError("Wait for a pending image before generating another.");
    const grants = await tx.$queryRaw<{ id: string; remaining: number }[]>`SELECT "id", "remaining" FROM "AiCreditGrant" WHERE "workspaceId" = ${actor.workspaceId} AND "remaining" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > ${now}) ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC FOR UPDATE`;
    if (!grants[0]) throw new AiCreditError("No AI credits left. A generated image needs 1 AI credit.");
    const budgetCents = Number(process.env.AI_VIDEO_BUDGET_CENTS ?? 24000);
    if (!Number.isSafeInteger(budgetCents) || budgetCents < CAMERA_KEYFRAME_HOLD_CENTS) throw new KeyframeError("Image budget is unavailable.", 403);
    await tx.$executeRaw`INSERT INTO "AiSpendBudget" ("id") VALUES ('vertex-video') ON CONFLICT ("id") DO NOTHING`;
    const reserved = await tx.aiSpendBudget.updateMany({ where: { id: "vertex-video", reservedCents: { lte: budgetCents - CAMERA_KEYFRAME_HOLD_CENTS } }, data: { reservedCents: { increment: CAMERA_KEYFRAME_HOLD_CENTS } } });
    if (reserved.count !== 1) throw new KeyframeError("AI generation is temporarily paused. No credits used.", 403);
    await tx.aiCreditGrant.update({ where: { id: grants[0].id }, data: { remaining: { decrement: 1 } } });
    // Only admitted new work may retain private inputs. The billing lock also serializes same-ID retries.
    await persist?.();
    return tx.aiKeyframe.create({ data: { workspaceId: actor.workspaceId, userId: actor.id, requestId: value.requestId, inputHash: value.inputHash, requestHash: value.requestHash, input: value.input as Prisma.InputJsonValue, snapshot: value.snapshot as unknown as Prisma.InputJsonValue, grantId: grants[0].id } });
  }, { timeout: 30_000 });
}
/** Definitively unsubmitted work releases both the customer credit and provider hold. */
export async function failUnsubmittedKeyframe(db: PrismaClient, id: string, error: string) {
  return db.$transaction(async tx => {
    const initial = await tx.aiKeyframe.findUniqueOrThrow({ where: { id } });
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${initial.workspaceId} FOR UPDATE`;
    const changed = await tx.aiKeyframe.updateMany({ where: { id, status: "QUEUED", submittedAt: null, creditRefunded: false }, data: { status: "FAILED", error, heldCostCents: 0, creditRefunded: true } });
    if (changed.count) {
      await tx.aiCreditGrant.update({ where: { id: initial.grantId }, data: { remaining: { increment: 1 } } });
      await tx.aiSpendBudget.update({ where: { id: "vertex-video" }, data: { reservedCents: { decrement: CAMERA_KEYFRAME_HOLD_CENTS } } });
    }
  });
}
/** A retained, complete HTTP refusal returns the customer's credit once, retaining the cash hold. */
export async function refundRefusedKeyframe(db: PrismaClient, id: string, httpStatus: number) {
  if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599) throw new KeyframeError("A definitive HTTP refusal is required for this credit refund.");
  return db.$transaction(async tx => {
    const initial = await tx.aiKeyframe.findUniqueOrThrow({ where: { id } });
    // Same billing lock/order as every other credit writer; refund the original grant, retaining its expiry.
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${initial.workspaceId} FOR UPDATE`;
    const changed = await tx.aiKeyframe.updateMany({ where: { id, status: { in: ["SUBMITTING", "UNKNOWN"] }, creditRefunded: false,
      submittedAt: { not: null }, responseKey: { not: null }, responseHash: { not: null } },
    data: { status: "FAILED", creditRefunded: true, error: `Image service refused the request (HTTP ${httpStatus}). Your 1 AI credit was returned.` } });
    if (changed.count) await tx.aiCreditGrant.update({ where: { id: initial.grantId }, data: { remaining: { increment: 1 } } });
  });
}
