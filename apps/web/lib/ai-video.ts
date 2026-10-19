import { AI_VIDEO_MODEL, aiClipCostCents, aiDefaultClipSeconds, aiShotSchema, aiShotPrompt, isEquirect } from "@reelwalk/core";
import { aiCreditSummary, prisma, reserveAiGeneration } from "@reelwalk/db";
import { z } from "zod";
import { mediaScope } from "./workspace";
import { storageBlockedReason } from "./quotas";

/** Voiced takes (ADR 0038) need the voice and lip-sync keys on the worker; the web only needs the switch. */
export function aiVoiceConfigured(): boolean {
  return process.env.VOICE_ENABLED === "true";
}

export function aiVideoConfigured(): boolean {
  return process.env.AI_VIDEO_ENABLED === "true" && Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}

export const generationInput = z.object({
  requestId: z.string().uuid(), prompt: z.string().trim().min(10).max(2000),
  referenceAssetId: z.string().min(1).max(64).optional(),
  shot: aiShotSchema.optional(),
  durationSeconds: z.union([z.literal(4), z.literal(8)]).optional(),
});

export async function createAiGeneration(user: { id: string; workspaceId: string; email: string }, input: z.infer<typeof generationInput>, options: { exactPrompt?: boolean } = {}) {
  if (!aiVideoConfigured()) throw new Error("AI video is being connected. Please check back soon.");
  // The shared demo is public and must never spend the trial credit.
  if (user.email === "demo@reelwalk.local") throw new Error("Create your own account to try AI video.");
  const storageError = await storageBlockedReason(user.workspaceId, 100 * 1024 * 1024, "An AI clip");
  if (storageError) throw new Error(storageError);
  if (input.shot?.draftReelId && !await prisma.reel.findFirst({ where: { id: input.shot.draftReelId, workspaceId: user.workspaceId }, select: { id: true } })) {
    throw new Error("That source reel is no longer available.");
  }
  const reference = input.referenceAssetId ? await prisma.mediaAsset.findFirst({
    where: { id: input.referenceAssetId, kind: "IMAGE", contentType: { in: ["image/jpeg", "image/png"] }, ...mediaScope(user.workspaceId) },
  }) : null;
  if (input.referenceAssetId && (!reference || reference.sizeBytes > 20 * 1024 * 1024)) {
    throw new Error("Choose a JPEG or PNG photo under 20 MB from your media library.");
  }
  // Resolve IDs here, never accept storage keys or URLs from a browser.
  const frames = [];
  const wanted: ["first" | "last" | "presenter", { assetId: string; atMs: number } | undefined][] = [["first", input.shot?.first], ["last", input.shot?.last], ["presenter", input.shot?.compose?.presenter]];
  for (const [role, frame] of wanted) {
    if (!frame) continue;
    const asset = await prisma.mediaAsset.findFirst({ where: { id: frame.assetId, ...mediaScope(user.workspaceId) } });
    if (!asset || !["IMAGE", "VIDEO"].includes(asset.kind) || isEquirect(asset.width, asset.height)) {
      throw new Error("Choose a flat photo or video from your media library.");
    }
    if (asset.kind === "IMAGE" && (!["image/jpeg", "image/png"].includes(asset.contentType) || asset.sizeBytes > 20 * 1024 * 1024)) {
      throw new Error("Choose a JPEG or PNG photo under 20 MB.");
    }
    if (asset.kind === "VIDEO" && (!asset.durationMs || frame.atMs >= asset.durationMs)) {
      throw new Error("Choose a frame within the source video's duration.");
    }
    if (role !== "presenter" && (input.shot?.mode === "gimbal" || input.shot?.mode === "drone") && asset.kind !== "IMAGE") {
      throw new Error("Choose a photo for this camera move.");
    }
    const compose = role === "first" ? input.shot?.compose?.first : role === "last" ? input.shot?.compose?.last : undefined;
    frames.push({ key: asset.objectKey, kind: asset.kind, atMs: asset.kind === "IMAGE" ? 0 : frame.atMs, role, ...(compose ? { compose } : {}) });
  }
  const voiced = Boolean(input.shot?.voice);
  if (voiced && !aiVoiceConfigured()) throw new Error("Voiced shots are being connected. Please check back soon.");
  const durationSeconds = input.durationSeconds ?? aiDefaultClipSeconds(input.shot?.mode);
  const budgetCents = Number(process.env.AI_VIDEO_BUDGET_CENTS ?? 24000);
  if (!Number.isSafeInteger(budgetCents) || budgetCents < aiClipCostCents(durationSeconds, voiced)) throw new Error("AI generation is temporarily paused.");
  return reserveAiGeneration(prisma, {
    workspaceId: user.workspaceId, userId: user.id, requestId: input.requestId,
    prompt: input.shot && !options.exactPrompt ? aiShotPrompt(input.shot.mode, input.prompt, input.shot) : input.prompt,
    shot: input.shot, frameSources: frames.length ? frames : undefined,
    referenceKey: reference?.objectKey, referenceType: reference?.contentType,
    model: AI_VIDEO_MODEL, durationSeconds, costCents: aiClipCostCents(durationSeconds, voiced), budgetCents, voiced,
  });
}

export const getAiBalance = (workspaceId: string) => aiCreditSummary(prisma, workspaceId);
