import { AI_VIDEO_MODEL, aiClipCostCents, aiDefaultClipSeconds, aiShotSchema, aiShotPrompt, isEquirect } from "@reelwalk/core";
import { aiCreditSummary, prisma, reserveAiGeneration } from "@reelwalk/db";
import { z } from "zod";
import { mediaScope } from "./workspace";
import { storageBlockedReason } from "./quotas";

export function aiVideoConfigured(): boolean {
  return process.env.AI_VIDEO_ENABLED === "true" && Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}

export const generationInput = z.object({
  requestId: z.string().uuid(), prompt: z.string().trim().min(10).max(2000),
  referenceAssetId: z.string().min(1).max(64).optional(),
  shot: aiShotSchema.optional(),
  durationSeconds: z.union([z.literal(4), z.literal(8)]).optional(),
});

export async function createAiGeneration(user: { id: string; workspaceId: string; email: string }, input: z.infer<typeof generationInput>) {
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
  for (const frame of [input.shot?.first, input.shot?.last].filter(f => f !== undefined)) {
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
    if ((input.shot?.mode === "gimbal" || input.shot?.mode === "drone") && asset.kind !== "IMAGE") {
      throw new Error("Choose a photo for this camera move.");
    }
    frames.push({ key: asset.objectKey, kind: asset.kind, atMs: asset.kind === "IMAGE" ? 0 : frame.atMs });
  }
  const durationSeconds = input.durationSeconds ?? aiDefaultClipSeconds(input.shot?.mode);
  const budgetCents = Number(process.env.AI_VIDEO_BUDGET_CENTS ?? 24000);
  if (!Number.isSafeInteger(budgetCents) || budgetCents < aiClipCostCents(durationSeconds)) throw new Error("AI generation is temporarily paused.");
  return reserveAiGeneration(prisma, {
    workspaceId: user.workspaceId, userId: user.id, requestId: input.requestId,
    prompt: input.shot ? aiShotPrompt(input.shot.mode, input.prompt, input.shot) : input.prompt,
    shot: input.shot, frameSources: frames.length ? frames : undefined,
    referenceKey: reference?.objectKey, referenceType: reference?.contentType,
    model: AI_VIDEO_MODEL, durationSeconds, costCents: aiClipCostCents(durationSeconds), budgetCents,
  });
}

export const getAiBalance = (workspaceId: string) => aiCreditSummary(prisma, workspaceId);
