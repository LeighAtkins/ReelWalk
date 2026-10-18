import { AI_VIDEO_MODEL, aiClipCostCents, canDirectAiVideo } from "@reelwalk/core";
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
  consent: z.boolean().default(false),
  execution: z.enum(["manual", "director"]).default("manual"),
  durationSeconds: z.union([z.literal(4), z.literal(8)]).default(4),
});

export async function createAiGeneration(user: { id: string; workspaceId: string; email: string }, input: z.infer<typeof generationInput>) {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId }, select: { plan: true, aiVideoMode: true } });
  if (input.execution === "director" ? !canDirectAiVideo(workspace) : !input.consent) throw new Error("Approve the Veo credit cost before generating this shot.");
  if (!aiVideoConfigured()) throw new Error("AI video is being connected. Please check back soon.");
  // The shared demo is public and must never spend the trial credit.
  if (user.email === "demo@reelwalk.local") throw new Error("Create your own account to try AI video.");
  const storageError = await storageBlockedReason(user.workspaceId, 100 * 1024 * 1024, "An AI clip");
  if (storageError) throw new Error(storageError);
  const reference = input.referenceAssetId ? await prisma.mediaAsset.findFirst({
    where: { id: input.referenceAssetId, kind: "IMAGE", contentType: { in: ["image/jpeg", "image/png"] }, ...mediaScope(user.workspaceId) },
  }) : null;
  if (input.referenceAssetId && (!reference || reference.sizeBytes > 20 * 1024 * 1024)) {
    throw new Error("Choose a JPEG or PNG photo under 20 MB from your media library.");
  }
  const { durationSeconds } = input;
  const budgetCents = Number(process.env.AI_VIDEO_BUDGET_CENTS ?? 24000);
  if (!Number.isSafeInteger(budgetCents) || budgetCents < aiClipCostCents(durationSeconds)) throw new Error("AI generation is temporarily paused.");
  return reserveAiGeneration(prisma, {
    workspaceId: user.workspaceId, userId: user.id, requestId: input.requestId, prompt: input.prompt,
    referenceKey: reference?.objectKey, referenceType: reference?.contentType,
    model: AI_VIDEO_MODEL, durationSeconds, costCents: aiClipCostCents(durationSeconds), budgetCents,
  });
}

export const getAiBalance = (workspaceId: string) => aiCreditSummary(prisma, workspaceId);
