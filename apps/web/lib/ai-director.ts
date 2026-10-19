import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { DIRECTOR_INSTRUCTIONS, DIRECTOR_PLAN_JSON_SCHEMA, AI_EDIT_SYSTEM_PROMPT, applyAiEditPlan, describeReel, directorPlanSchema, isEquirect, parseTimeline, referencedAssetIds, validateDirectorReferences } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { aiEditBlockedReason, context, newAssets } from "./ai-edit";
import { aiModel, aiProvider, structuredAnswer } from "./openai";
import { mediaScope } from "./workspace";

export const directorInput = z.object({
  requestId: z.string().uuid(), request: z.string().trim().min(3).max(4000),
  timeline: z.unknown(), candidates: z.array(z.string().min(1).max(64)).max(6),
  evidence: z.array(z.object({
    assetId: z.string().min(1).max(64), timesMs: z.array(z.number().int().nonnegative()).min(1).max(40),
    image: z.string().startsWith("data:image/jpeg;base64,").max(1_200_000),
  })).max(10),
});
export type DirectorInput = z.infer<typeof directorInput>;

/** Limit decoded evidence too, rather than trusting a browser MIME label. */
async function pictures(input: DirectorInput, allowed: Record<string, { kind: string; durationMs: number | null }>) {
  let total = 0;
  return Promise.all(input.evidence.map(async e => {
    const asset = allowed[e.assetId];
    if (!asset || !["IMAGE", "VIDEO"].includes(asset.kind)) throw new Error("A review image is not from this reel's available media.");
    if (e.timesMs.some(t => asset.kind === "VIDEO" ? !asset.durationMs || t >= asset.durationMs : t !== 0)) throw new Error("A review timestamp is outside its source.");
    const bytes = Buffer.from(e.image.slice("data:image/jpeg;base64,".length), "base64");
    total += bytes.length;
    if (total > 6_000_000) throw new Error("Choose fewer review frames.");
    const safe = await sharp(bytes, { limitInputPixels: 16_000_000 }).rotate().resize({ width: 1536, height: 2048, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { image: `data:image/jpeg;base64,${safe.toString("base64")}`, assetId: e.assetId, timesMs: e.timesMs, sha256: createHash("sha256").update(safe).digest("hex") };
  }));
}

export async function directReel(user: { id: string; workspaceId: string }, reel: { id: string; title: string }, input: DirectorInput) {
  if (aiProvider() !== "anthropic" || !/^claude-opus-/.test(aiModel())) throw new Error("Connect Claude Opus to use the director.");
  const blocked = await aiEditBlockedReason(user.workspaceId);
  if (blocked) throw new Error(blocked.message);
  const timeline = parseTimeline(input.timeline);
  const available = await context(user.workspaceId, timeline);
  const ids = [...new Set([...referencedAssetIds(timeline), ...input.candidates])];
  const selected = await prisma.mediaAsset.findMany({ where: { ...mediaScope(user.workspaceId), id: { in: ids } }, select: { id: true, kind: true, fileName: true, durationMs: true, width: true, height: true, bpm: true, beatOffsetMs: true, room: true } });
  for (const row of selected) {
    const asset = { id: row.id, kind: row.kind, title: row.fileName, durationMs: row.durationMs, isPano: isEquirect(row.width, row.height), bpm: row.bpm, beatOffsetMs: row.beatOffsetMs, room: row.room };
    if (input.candidates.includes(row.id) && (!['IMAGE', 'VIDEO'].includes(row.kind) || asset.isPano)) throw new Error("Choose a flat photo or video as a review candidate.");
    available.assets[row.id] = asset;
    if (input.candidates.includes(row.id) && !timeline.clips.some(c => c.assetId === row.id) && !available.unused.some(a => a.id === row.id)) available.unused.push(asset);
  }
  // Candidate choices are material supplied for review, not a request to add it.
  for (const id of input.candidates) if (!available.assets[id]) throw new Error("A candidate is no longer available. Reopen the director.");
  if (await prisma.mediaAsset.count({ where: { ...mediaScope(user.workspaceId), id: { in: ids } } }) !== ids.length) throw new Error("The reel contains unavailable media.");
  const evidence = await pictures(input, available.assets);
  const aiSources = await prisma.aiGeneration.findMany({ where: { workspaceId: user.workspaceId, status: "SUCCEEDED", assetId: { in: ids } }, select: { assetId: true } });
  const record = await prisma.aiEdit.create({ data: {
    workspaceId: user.workspaceId, userId: user.id, reelId: reel.id, request: input.request,
    note: "Opus director review in progress", model: "pending", plan: { kind: "director-pending", requestId: input.requestId }, applied: [], skipped: [],
  }, select: { id: true } });
  // Deliberately one provider request. Unknown or failed submissions are never automatically repeated.
  const answer = await structuredAnswer({
    instructions: `${AI_EDIT_SYSTEM_PROMPT}\n\n${DIRECTOR_INSTRUCTIONS}`,
    input: `${describeReel({ title: reel.title, timeline, ...available })}\n\nUser brief: ${input.request}\n\nConfirmed AI-generated asset IDs: ${JSON.stringify(aiSources.map(a => a.assetId))}\nReview candidates: ${JSON.stringify(input.candidates)}\nSource frame sheets in order: ${JSON.stringify(evidence.map(e => ({ assetId: e.assetId, timesMs: e.timesMs })))}\nNo source sheets supplied for other shots: do not claim those were visually reviewed.`,
    images: evidence.map(e => e.image), imageDetail: "high", schemaName: "opus_director", schema: DIRECTOR_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>, // A full direction (caption moves, trims, volume, shots) plus Opus's thinking ran past 10k tokens.
    maxOutputTokens: 30000,
    // Opus thinks over many frame sheets; the 60-second default cut real reviews off. This runs as a background job.
    signal: AbortSignal.timeout(300_000),
  });
  const plan = directorPlanSchema.parse(answer.json);
  if (plan.verdict === "ready" && (!evidence.length || aiSources.some(a => !evidence.some(e => e.assetId === a.assetId && e.timesMs.length >= 3)))) throw new Error("Opus reported ready without enough AI source-frame evidence. No edit or generation was applied.");
  if (plan.verdict === "needs-generation" && !plan.shots.length) throw new Error("Opus asked for a new shot but did not write it. Ask again.");
  validateDirectorReferences(plan, available.assets);
  const applied = applyAiEditPlan(timeline, plan.edit, { ...available, newId: () => crypto.randomUUID() });
  const stored = { kind: "director", plan, baseline: timeline, timeline: applied.timeline, evidence: evidence.map(e => ({ assetId: e.assetId, timesMs: e.timesMs, sha256: e.sha256 })) };
  await prisma.aiEdit.update({ where: { id: record.id }, data: {
    model: answer.model, note: plan.note, plan: stored as never, applied: applied.applied, skipped: applied.skipped,
    inputTokens: answer.usage.inputTokens, cachedTokens: answer.usage.cachedTokens, outputTokens: answer.usage.outputTokens,
  } });
  return { ok: true as const, editId: record.id, model: answer.model, ...stored, assets: await newAssets(user.workspaceId, timeline, applied.timeline), applied: applied.applied, skipped: applied.skipped };
}
