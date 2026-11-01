import { randomInt } from "node:crypto";
import { AI_DRAFT_MODEL, AI_OMNI_MODEL, AI_VIDEO_MODEL, aiOmniCostCents, CHAINED_REFERENCE_MESSAGE, MOVE_IDS, aiClipCostCents, aiDefaultClipSeconds, aiDraftCostCents, aiShotSchema, aiShotPrompt, composeFraming, directionStill, hasDirection, isEquirect, isGeneratedAssetId, parseStoredAiShot, referenceDepthOf, type AiShot } from "@reelwalk/core";
import { aiCreditSummary, prisma, reserveAiGeneration } from "@reelwalk/db";
import type { Prisma } from "@reelwalk/db";
import { z } from "zod";
import { mediaScope } from "./media-scope";
import { storageBlockedReason } from "./quotas";
import { assertAiOn } from "./ai-gate";

/** Voiced takes (ADR 0038) need the voice and lip-sync keys on the worker; the web only needs the switch. */
export function aiVoiceConfigured(): boolean {
  return process.env.VOICE_ENABLED === "true";
}

/**
 * Lip sync (ADR 0038) also needs the sync.so key, which only the worker holds. The web is told it is there with
 * LIPSYNC_ENABLED, set together with the key; until then only Veo's own voice is offered (ADR 0060).
 */
export function aiLipsyncConfigured(): boolean {
  return aiVoiceConfigured() && process.env.LIPSYNC_ENABLED === "true";
}

/** Gemini Omni Flash (ADR 0105): the worker holds the Gemini API key; the web only needs the switch. */
export function aiOmniConfigured(): boolean {
  return process.env.AI_OMNI_ENABLED === "true";
}

export function aiVideoConfigured(): boolean {
  return process.env.AI_VIDEO_ENABLED === "true" && Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}

export const generationInput = z.object({
  requestId: z.string().uuid(), prompt: z.string().trim().min(10).max(2000),
  referenceAssetId: z.string().min(1).max(64).optional(),
  shot: aiShotSchema.optional(),
  durationSeconds: z.union([z.literal(4), z.literal(8)]).optional(),
  /** A named camera move from the moves table (ADR 0076): its words replace the mode's camera sentence. */
  move: z.enum(MOVE_IDS).optional(),
  /** "draft" is the cheap preview tier (ADR 0076); absent or "final" is the full take. */
  quality: z.enum(["draft", "final"]).optional(),
  /** Make this finished draft final: the same prompt, frames and seed on the full model, the draft's credit used toward the price. */
  finalOf: z.string().min(1).max(64).optional(),
});

type AiUser = { id: string; workspaceId: string; email: string };

async function assertMayGenerate(user: AiUser) {
  // The workspace's AI switch comes first (ADR 0079): off means no generation, no reservation, no credits.
  await assertAiOn(user.workspaceId);
  if (!aiVideoConfigured()) throw new Error("AI video is being connected. Please check back soon.");
  // The shared demo is public and must never spend the trial credit.
  if (user.email === "demo@reelwalk.local") throw new Error("Create your own account to try AI video.");
  const storageError = await storageBlockedReason(user.workspaceId, 100 * 1024 * 1024, "An AI clip");
  if (storageError) throw new Error(storageError);
}

/**
 * "Make it final" (ADR 0076): the finished draft's prompt, frames, presenter and seed again on the full model. Everything
 * the draft was asked is read back from its row, never from the browser, so the final is the closest reproducible take;
 * the worker composes and gates the stills again as for any take. The draft's credit is used toward the price inside the
 * reservation, under the account lock.
 */
async function createFinal(user: AiUser, input: z.infer<typeof generationInput>) {
  const draft = await prisma.aiGeneration.findFirst({ where: { id: input.finalOf, workspaceId: user.workspaceId, status: "SUCCEEDED" } });
  const stored = draft ? parseStoredAiShot(draft.shot) : null;
  if (!draft || !stored?.success || stored.data.tier !== "draft") throw new Error("Make it final needs a finished draft from this workspace.");
  const shot: AiShot = { ...stored.data, tier: "final", finalOf: draft.id };
  const voiced = Boolean(shot.voice && shot.line);
  if (voiced && !aiVoiceConfigured()) throw new Error("Voiced shots are being connected. Please check back soon.");
  const durationSeconds = draft.durationSeconds as 4 | 8;
  const budgetCents = Number(process.env.AI_VIDEO_BUDGET_CENTS ?? 24000);
  if (!Number.isSafeInteger(budgetCents) || budgetCents < aiClipCostCents(durationSeconds, voiced)) throw new Error("AI generation is temporarily paused.");
  return reserveAiGeneration(prisma, {
    workspaceId: user.workspaceId, userId: user.id, requestId: input.requestId, prompt: draft.prompt, shot: shot as Prisma.InputJsonValue,
    frameSources: (draft.frameSources ?? undefined) as Prisma.InputJsonValue | undefined,
    referenceKey: draft.referenceKey ?? undefined, referenceType: draft.referenceType ?? undefined,
    model: AI_VIDEO_MODEL, durationSeconds, costCents: aiClipCostCents(durationSeconds, voiced), budgetCents, voiced,
    presenterId: draft.presenterId ?? undefined, referenceDepth: draft.referenceDepth ?? undefined, tier: "final", finalOf: draft.id,
  });
}

export async function createAiGeneration(user: AiUser, request: z.infer<typeof generationInput>, options: { exactPrompt?: boolean } = {}) {
  await assertMayGenerate(user);
  if (request.finalOf) return createFinal(user, request);
  // A named move and the tier belong to the shot (ADR 0076), so they are stored with it and read back by the worker.
  const draft = request.quality === "draft";
  const merged = request.move || draft ? aiShotSchema.safeParse({
    ...(request.shot ?? { mode: "custom" }), ...(request.move ? { move: request.move } : {}),
    ...(draft ? { tier: "draft", seed: request.shot?.seed ?? randomInt(1, 2 ** 32), draftReelId: undefined } : {}),
  }) : null;
  if (merged && !merged.success) throw new Error(merged.error.issues[0]?.message || "Choose a valid shot.");
  const input = { ...request, shot: merged?.data ?? request.shot };
  const omni = input.shot?.engine === "omni";
  if (omni && !aiOmniConfigured()) throw new Error("Gemini Omni is being connected. Please check back soon.");
  if (input.shot?.extendOf) {
    // Carrying on from an earlier take (ADR 0105): only a finished Omni take of this workspace, whose interaction the worker can extend.
    const source = await prisma.aiGeneration.findFirst({ where: { id: input.shot.extendOf, workspaceId: user.workspaceId, status: "SUCCEEDED" }, select: { model: true, operationName: true } });
    if (!source || !source.model.startsWith("gemini-omni") || !source.operationName?.startsWith("omni:")) throw new Error("Choose a finished Omni take from this workspace to carry on from.");
  }
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
  const compose = input.shot?.compose;
  // Who she is (ADR 0056): the kit's real stills, never a generated take unless the caller explicitly allows it.
  const kit = compose?.presenterId ? await presenterKit(user.workspaceId, compose.presenterId) : null;
  let referenceDepth: number | undefined;
  if (kit) {
    frames.push({ key: kit.fullBody.objectKey, kind: "IMAGE", atMs: 0, role: "presenter" }, { key: kit.faceCropKey, kind: "IMAGE", atMs: 0, role: "face" });
    referenceDepth = referenceDepthOf({ kit: true });
  } else if (compose?.presenter) {
    if (isGeneratedAssetId(compose.presenter.assetId) && !compose.allowGeneratedReference) throw new Error(CHAINED_REFERENCE_MESSAGE);
    const source = isGeneratedAssetId(compose.presenter.assetId)
      ? await prisma.aiGeneration.findFirst({ where: { assetId: compose.presenter.assetId, workspaceId: user.workspaceId }, select: { referenceDepth: true } }) : null;
    referenceDepth = referenceDepthOf({ assetId: compose.presenter.assetId, sourceDepth: source?.referenceDepth });
  }
  const wanted: ["first" | "last" | "presenter", { assetId: string; atMs: number } | undefined][] = [["first", input.shot?.first], ["last", input.shot?.last], ["presenter", kit ? undefined : compose?.presenter]];
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
    const written = role === "first" ? compose?.first : role === "last" ? compose?.last : undefined;
    // The direction's expression and pose go into the still (ADR 0069): the first frame is what Veo continues from.
    const acting = written && role !== "presenter" && hasDirection(input.shot?.direction) ? directionStill(input.shot!.direction, role) : "";
    const described = written ? [written, acting].filter(Boolean).join(" ").slice(0, 1000) : undefined;
    frames.push({ key: asset.objectKey, kind: asset.kind, atMs: asset.kind === "IMAGE" ? 0 : frame.atMs, role, ...(described ? { compose: described, framing: input.shot ? composeFraming(input.shot) : "medium" } : {}) });
  }
  // A draft is a silent preview: the voice is made, and charged, with the final.
  const voiced = Boolean(input.shot?.voice) && !draft;
  if (voiced && !aiVoiceConfigured()) throw new Error("Voiced shots are being connected. Please check back soon.");
  const durationSeconds = input.durationSeconds ?? aiDefaultClipSeconds(input.shot?.mode, input.shot?.move);
  const costCents = omni ? aiOmniCostCents(durationSeconds, draft ? "draft" : "final") : draft ? aiDraftCostCents(durationSeconds) : aiClipCostCents(durationSeconds, voiced);
  const budgetCents = Number(process.env.AI_VIDEO_BUDGET_CENTS ?? 24000);
  if (!Number.isSafeInteger(budgetCents) || budgetCents < costCents) throw new Error("AI generation is temporarily paused.");
  return reserveAiGeneration(prisma, {
    workspaceId: user.workspaceId, userId: user.id, requestId: input.requestId,
    prompt: input.shot && !options.exactPrompt ? aiShotPrompt(input.shot.mode, input.prompt, input.shot) : input.prompt,
    shot: input.shot, frameSources: frames.length ? frames : undefined,
    referenceKey: reference?.objectKey, referenceType: reference?.contentType,
    model: omni ? AI_OMNI_MODEL : draft ? AI_DRAFT_MODEL : AI_VIDEO_MODEL, durationSeconds, costCents, budgetCents, voiced,
    presenterId: kit?.id, referenceDepth, ...(draft ? { tier: "draft" as const } : {}),
  });
}

/** A ready presenter kit of this workspace, with its full-length still; the browser only ever names it by id. */
export async function presenterKit(workspaceId: string, id: string) {
  const kit = await prisma.presenter.findFirst({ where: { id, workspaceId } });
  if (!kit) throw new Error("That presenter is not in your workspace.");
  if (!kit.faceCropKey) throw new Error(kit.faceCropError ?? "Her face reference is still being prepared. Try again in a minute.");
  const fullBody = await prisma.mediaAsset.findFirst({ where: { id: kit.fullBodyAssetId, workspaceId, kind: "IMAGE" } });
  if (!fullBody) throw new Error("The presenter's full-length photo is no longer in your library. Choose another in Set up presenter.");
  return { id: kit.id, faceCropKey: kit.faceCropKey, fullBody };
}

export const getAiBalance = (workspaceId: string) => aiCreditSummary(prisma, workspaceId);
