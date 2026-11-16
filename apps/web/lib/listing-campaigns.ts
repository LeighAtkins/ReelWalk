import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { applyCampaignFacts, buildListingCampaign, campaignCaption, campaignFactsSchema, parseTimeline, parseReelExportPayload, referencedAssetIds, timelineGeneration, type CampaignRole } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { mediaScope } from "./media-scope";
import { queueReelExport } from "./export-reel";
import { outputUrls } from "./render-jobs";
import type { Tx } from "./save-fence";

type User = { id: string; workspaceId: string };
const keySchema = z.string().uuid();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export class CampaignError extends Error {}
function fail(message: string): never { throw new CampaignError(message); }

async function lockCampaign(tx: Tx, workspaceId: string, id: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ListingCampaign" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  if (!locked.length) fail("This campaign is unavailable.");
  return tx.listingCampaign.findUniqueOrThrow({ where: { id }, include: { outputs: { orderBy: { reelId: "asc" }, include: { reel: true } } } });
}
async function lockReels(tx: Tx, workspaceId: string, ids: string[]) {
  for (const id of [...ids].sort()) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Reel" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (!rows.length) fail("A campaign reel was deleted or is unavailable. Reload the campaign.");
  }
}

export async function createListingCampaign(user: User, raw: unknown): Promise<string> {
  const input = z.object({ sourceReelId: z.string().min(1), sourceRevision: z.number().int().nonnegative(), title: z.string().trim().min(1).max(60), requestKey: keySchema, facts: campaignFactsSchema }).parse(raw);
  const creationHash = digest({ sourceReelId: input.sourceReelId, sourceRevision: input.sourceRevision, title: input.title, facts: input.facts });
  return prisma.$transaction(async (tx) => {
    // Serialize retries before reading or copying the source; a replay survives later source edits.
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`listing-campaign:${user.workspaceId}:${input.requestKey}`}::text))) AS lock`;
    const previous = await tx.listingCampaign.findUnique({ where: { workspaceId_requestKey: { workspaceId: user.workspaceId, requestKey: input.requestKey } } });
    if (previous) {
      if (previous.creationHash !== creationHash) fail("That request was already used for another campaign. Reload and try again.");
      return previous.id;
    }
    await lockReels(tx, user.workspaceId, [input.sourceReelId]);
    const source = await tx.reel.findFirst({ where: { id: input.sourceReelId, workspaceId: user.workspaceId } });
    if (!source || source.revision !== input.sourceRevision) fail("The source reel changed. Reload before making its campaign.");
    const timeline = parseTimeline(source.timeline);
    const ids = referencedAssetIds(timeline);
    const available = await tx.mediaAsset.count({ where: { id: { in: ids }, ...mediaScope(user.workspaceId) } });
    if (available !== ids.length) fail("Some source media is unavailable. Repair the source reel first.");
    const cuts = buildListingCampaign(timeline, input.facts);
    const campaign = await tx.listingCampaign.create({ data: { workspaceId: user.workspaceId, sourceReelId: source.id, title: input.title, requestKey: input.requestKey, creationHash, facts: input.facts } });
    for (const cut of cuts) {
      const reel = await tx.reel.create({ data: { workspaceId: user.workspaceId, title: `${input.title} · ${cut.role}`.slice(0, 80), timeline: cut.timeline, caption: cut.caption } });
      await tx.campaignOutput.create({ data: { campaignId: campaign.id, reelId: reel.id, role: cut.role, boundCaption: cut.caption } });
    }
    return campaign.id;
  }, { timeout: 15_000 });
}

export async function listingCampaign(workspaceId: string, id: string) {
  return prisma.listingCampaign.findFirst({ where: { id, workspaceId }, include: { outputs: { orderBy: { role: "asc" }, include: { reel: { include: { renderJobs: { where: { kind: "REEL" }, orderBy: { createdAt: "desc" }, take: 3, include: { output: true } } } }, reviews: { orderBy: { createdAt: "desc" }, take: 3, include: { comments: { orderBy: { createdAt: "asc" } } } } } } } });
}

/** Rebase shared facts on each current cut. Every expected revision is checked
 * under locks; all three cuts save together or none do. User copy conflicts fail
 * explicitly rather than deleting a separately edited caption/fact card. */
export async function updateListingCampaign(user: User, id: string, raw: unknown): Promise<void> {
  const input = z.object({ revision: z.number().int().nonnegative(), requestKey: keySchema, reels: z.record(z.string(), z.number().int().nonnegative()), facts: campaignFactsSchema }).parse(raw);
  const hash = digest({ revision: input.revision, reels: input.reels, facts: input.facts });
  await prisma.$transaction(async (tx) => {
    let campaign = await lockCampaign(tx, user.workspaceId, id);
    if (campaign.lastRequestKey === input.requestKey) {
      if (campaign.lastRequestHash !== hash) fail("That update request was already used. Reload the campaign.");
      return;
    }
    if (campaign.revision !== input.revision) fail("The shared details changed in another tab. Reload before applying.");
    if (campaign.outputs.length !== 3 || Object.keys(input.reels).length !== 3) fail("The campaign no longer has all three outputs. Reload before applying.");
    await lockReels(tx, user.workspaceId, campaign.outputs.map((output) => output.reelId));
    // The include above preceded the locks: re-read after waiting for an editor save.
    campaign = await tx.listingCampaign.findUniqueOrThrow({ where: { id }, include: { outputs: { orderBy: { reelId: "asc" }, include: { reel: true } } } });
    const previousFacts = campaignFactsSchema.parse(campaign.facts);
    for (const output of campaign.outputs) {
      const reel = output.reel;
      if (input.reels[reel.id] !== reel.revision) fail("A campaign cut changed in another tab. Reload to keep that edit before applying details.");
      if (reel.caption !== output.boundCaption) fail(`The ${output.role} caption was edited separately. Restore its campaign caption before applying shared details.`);
      const current = parseTimeline(reel.timeline);
      const expected = applyCampaignFacts(current, previousFacts, output.role as CampaignRole);
      if (JSON.stringify(current.details) !== JSON.stringify(expected.details) || (output.role === "open-home" && current.texts.find((text) => text.id === "campaign-open-home")?.text !== `Open home · ${previousFacts.openHome}`)) fail(`The ${output.role} facts were edited separately. Restore the shared facts in that cut before applying.`);
      const timeline = applyCampaignFacts(current, input.facts, output.role as CampaignRole);
      const caption = campaignCaption(input.facts, output.role as CampaignRole);
      await tx.reel.update({ where: { id: reel.id }, data: { timeline, caption, revision: { increment: 1 } } });
      await tx.campaignOutput.update({ where: { id: output.id }, data: { appliedRevision: campaign.revision + 1, boundCaption: caption } });
    }
    await tx.campaignReview.updateMany({ where: { output: { campaignId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.listingCampaign.update({ where: { id }, data: { facts: input.facts, revision: { increment: 1 }, lastRequestKey: input.requestKey, lastRequestHash: hash } });
  }, { timeout: 15_000 });
}

export async function exportCampaignOutput(user: User, id: string, reelId: string, revision: number, factRevision: number): Promise<string> {
  const campaign = await listingCampaign(user.workspaceId, id);
  const member = campaign?.outputs.find((output) => output.reelId === reelId);
  if (!campaign || !member || campaign.revision !== factRevision || member.reel.revision !== revision) fail("The campaign changed. Reload before exporting.");
  const generation = timelineGeneration(member.reel.timeline);
  const same = member.reel.renderJobs.find((job) => job.status !== "FAILED" && timelineGeneration(parseReelExportPayload(job.payload).timeline) === generation && job.caption === member.reel.caption);
  if (same) return same.id;
  const result = await queueReelExport(user, reelId, { revision, captionSource: "listing", fence: {
    lock: async (tx) => {
      const current = await lockCampaign(tx, user.workspaceId, id);
      if (current.revision !== factRevision || !current.outputs.some((output) => output.reelId === reelId)) return "The campaign changed. Reload before exporting.";
      const jobs = await tx.renderJob.findMany({ where: { workspaceId: user.workspaceId, reelId, kind: "REEL", status: { in: ["QUEUED", "RUNNING", "SUCCEEDED"] } }, orderBy: { createdAt: "desc" }, take: 5 });
      return jobs.some((job) => timelineGeneration(parseReelExportPayload(job.payload).timeline) === generation && job.caption === member.reel.caption) ? "This cut is already exported or exporting. Reload to see its progress." : null;
    }, inTime: async () => null, committed: async () => {},
  } });
  if (!result.ok) fail(result.message || result.issues.map((issue) => issue.message).join(" ") || "This export could not start.");
  return result.jobId;
}

export async function createCampaignReview(user: User, campaignId: string, outputId: string, exportId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await prisma.$transaction(async (tx) => {
    const campaign = await lockCampaign(tx, user.workspaceId, campaignId);
    const member = campaign.outputs.find((output) => output.id === outputId);
    if (!member) fail("This output is unavailable.");
    await lockReels(tx, user.workspaceId, [member.reelId]);
    const reel = await tx.reel.findUniqueOrThrow({ where: { id: member.reelId } });
    const job = await tx.renderJob.findFirst({ where: { id: exportId, reelId: reel.id, workspaceId: user.workspaceId, kind: "REEL", status: "SUCCEEDED", output: { isNot: null } } });
    if (!job || timelineGeneration(parseReelExportPayload(job.payload).timeline) !== timelineGeneration(reel.timeline) || job.caption !== reel.caption) fail("Export the current cut before requesting review.");
    await tx.campaignReview.updateMany({ where: { outputId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.campaignReview.create({ data: { outputId, exportId, reelRevision: reel.revision, factRevision: campaign.revision, tokenHash: tokenHash(token), caption: reel.caption, expiresAt: new Date(Date.now() + 7 * 86400_000) } });
  });
  return token;
}

export async function readCampaignReview(token: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const review = await prisma.campaignReview.findUnique({ where: { tokenHash: tokenHash(token) }, include: { output: { include: { campaign: true, reel: true } }, export: { include: { output: true } }, comments: { orderBy: { createdAt: "asc" }, take: 50 } } });
  if (!review || !reviewCurrent(review)) return null;
  const urls = await outputUrls(review.export);
  return urls ? { ...review, urls } : null;
}

type ReviewState = { revokedAt: Date | null; expiresAt: Date; reelRevision: number; factRevision: number; caption: string; export: { workspaceId: string; reelId: string | null; kind: string; status: string; caption: string | null; payload: unknown }; output: { reelId: string; campaign: { workspaceId: string; revision: number }; reel: { workspaceId: string; revision: number; caption: string; timeline: unknown } } };
export function reviewCurrent(review: ReviewState, now = new Date()): boolean {
  const { campaign, reel } = review.output;
  try {
    return !review.revokedAt && review.expiresAt > now && review.factRevision === campaign.revision && review.reelRevision === reel.revision && reel.workspaceId === campaign.workspaceId && review.export.workspaceId === campaign.workspaceId && review.export.reelId === review.output.reelId && review.export.kind === "REEL" && review.export.status === "SUCCEEDED" && review.caption === reel.caption && review.export.caption === review.caption && timelineGeneration(parseReelExportPayload(review.export.payload).timeline) === timelineGeneration(reel.timeline);
  } catch { return false; }
}

export async function respondCampaignReview(token: string, raw: unknown): Promise<void> {
  const input = z.object({ requestKey: keySchema, name: z.string().trim().min(1).max(80), message: z.string().trim().max(1200), approve: z.boolean() }).parse(raw);
  if (!input.approve && !input.message) fail("Write a comment or approve this version.");
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) fail("This review link is unavailable.");
  await prisma.$transaction(async (tx) => {
    const found = await tx.campaignReview.findUnique({ where: { tokenHash: tokenHash(token) }, include: { output: { include: { campaign: true } } } });
    if (!found) fail("This review link is unavailable.");
    await lockCampaign(tx, found.output.campaign.workspaceId, found.output.campaignId);
    await lockReels(tx, found.output.campaign.workspaceId, [found.output.reelId]);
    const review = await tx.campaignReview.findUniqueOrThrow({ where: { id: found.id }, include: { output: { include: { campaign: true, reel: true } }, export: true } });
    if (!reviewCurrent(review)) fail("This version changed or its review link expired. Ask for a new review link.");
    const count = await tx.campaignReviewComment.count({ where: { reviewId: review.id } });
    const prior = await tx.campaignReviewComment.findUnique({ where: { reviewId_requestKey: { reviewId: review.id, requestKey: input.requestKey } } });
    const message = input.approve ? `[Approved this version]${input.message ? ` ${input.message}` : ""}` : input.message;
    if (prior) {
      if (prior.name !== input.name || prior.message !== message) fail("This review response was already submitted. Reload before sending another.");
      return;
    }
    if (count >= 50) fail("This review has reached its comment limit. Ask for a new review link.");
    await tx.campaignReviewComment.create({ data: { reviewId: review.id, requestKey: input.requestKey, name: input.name, message } });
    await tx.campaignReview.update({ where: { id: review.id }, data: { approvedAt: input.approve ? new Date() : null, reviewerName: input.approve ? input.name : null } });
  });
}

export async function revokeCampaignReview(user: User, campaignId: string, reviewId: string) {
  await prisma.$transaction(async (tx) => {
    await lockCampaign(tx, user.workspaceId, campaignId);
    await tx.campaignReview.updateMany({ where: { id: reviewId, output: { campaignId } }, data: { revokedAt: new Date() } });
  });
}
