import {
  VARIANT_HOOKS,
  VARIANT_HOOK_LABELS,
  buildVariants,
  parseTimeline,
  referencedAssetIds,
  transcriptSchema,
  variantWinner,
  type SkippedVariant,
  type Transcript,
  type VariantHook,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { queueReelExport } from "@/lib/export-reel";
import { postInsights } from "@/lib/instagram-messaging";
import { mediaScope } from "@/lib/media-scope";
import { exportsThisMonth, workspacePlan } from "@/lib/plans";
import { isUnlimited } from "@/lib/quotas";

/** Sets one reel may have: enough to try again after an edit, not a way to fill the reel list. */
export const MAX_SETS_PER_REEL = 5;
/** Instagram's numbers are read again at most this often per variant. */
const INSIGHTS_TTL_MS = 10 * 60_000;

export type MakeVariantsResult = { ok: true; groupId: string; made: number; skipped: SkippedVariant[] } | { ok: false; message: string };

/**
 * Variants (ADR 0063): sibling reels from one finished reel, three hooks at
 * 15 and 30 s, made with the editor's commands (`buildVariants` in core).
 * Each is an ordinary reel the studio can open, export and schedule; they
 * refer to the source's media assets (nothing is copied) and are kept
 * together as a set so their Instagram numbers can be compared.
 */
export async function makeVariantSet(user: { workspaceId: string }, reelId: string): Promise<MakeVariantsResult> {
  const reel = await prisma.reel.findFirst({ where: { id: reelId, workspaceId: user.workspaceId }, select: { id: true, title: true, caption: true, timeline: true, variant: { select: { groupId: true } } } });
  if (!reel) return { ok: false, message: "This reel was deleted." };
  if (reel.variant) return { ok: false, message: "This reel is already a variant. Make variants from the reel it came from." };
  const sets = await prisma.variantGroup.count({ where: { workspaceId: user.workspaceId, sourceReelId: reel.id } });
  if (sets >= MAX_SETS_PER_REEL) return { ok: false, message: `This reel already has ${sets} sets of variants. Delete some of their reels first.` };

  let timeline;
  try {
    timeline = parseTimeline(reel.timeline);
  } catch {
    return { ok: false, message: "This reel could not be read, so no variants were made." };
  }
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: referencedAssetIds(timeline) }, ...mediaScope(user.workspaceId) },
    select: { id: true, durationMs: true, transcript: true },
  });
  const transcripts: Record<string, Transcript | null> = {};
  for (const asset of assets) transcripts[asset.id] = asset.transcript ? (transcriptSchema.safeParse(asset.transcript).data ?? null) : null;
  const { variants, skipped } = buildVariants(timeline, {
    title: reel.title,
    sourceDurationsMs: Object.fromEntries(assets.map((asset) => [asset.id, asset.durationMs])),
    transcripts,
  });
  if (variants.length === 0) return { ok: false, message: skipped[0]?.reason ?? "No variants could be made from this reel." };

  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.variantGroup.create({ data: { workspaceId: user.workspaceId, sourceReelId: reel.id } });
    for (const variant of variants) {
      await tx.reel.create({
        data: {
          workspaceId: user.workspaceId,
          title: `${reel.title} · ${VARIANT_HOOK_LABELS[variant.hook]} · ${variant.lengthS} s`.slice(0, 80),
          caption: reel.caption,
          timeline: variant.timeline,
          variant: { create: { groupId: created.id, hook: variant.hook, lengthS: variant.lengthS } },
        },
      });
    }
    return created;
  });
  return { ok: true, groupId: group.id, made: variants.length, skipped };
}

/** The latest set a reel belongs to: its own (when it is a variant), else the newest made from it. */
export async function findVariantSet(workspaceId: string, reelId: string) {
  const own = await prisma.reelVariant.findFirst({ where: { reelId, reel: { workspaceId } }, select: { groupId: true } });
  const group = await prisma.variantGroup.findFirst({
    where: own ? { id: own.groupId, workspaceId } : { sourceReelId: reelId, workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      sourceReel: { select: { id: true, title: true } },
      variants: {
        include: {
          reel: {
            select: {
              id: true, title: true, timeline: true, updatedAt: true,
              renderJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, createdAt: true } },
            },
          },
        },
      },
    },
  });
  if (!group) return null;
  // Hooks in the set's order, then the shorter first.
  group.variants.sort((a, b) => VARIANT_HOOKS.indexOf(a.hook as VariantHook) - VARIANT_HOOKS.indexOf(b.hook as VariantHook) || a.lengthS - b.lengthS);
  return group;
}
export type VariantSet = NonNullable<Awaited<ReturnType<typeof findVariantSet>>>;

export type InsightsState =
  /** Numbers were read (now or earlier) for at least one posted variant. */
  | "read"
  /** None of the set is posted yet. */
  | "unposted"
  /** Posted, but there is no Instagram Login connection to read numbers with. */
  | "no-connection"
  /** The connection predates the insights permission: reconnect on Account. */
  | "permission"
  /** Posted and asked, but Instagram has no numbers yet (or the read failed); asked again after ten minutes. */
  | "waiting";

export type VariantNumbers = { views: number | null; reach: number | null; insightsAt: Date | null; postedAt: Date | null };

/**
 * Reads each posted variant's numbers from Instagram (ADR 0027) and stores
 * them on the variant, so the set can be compared later even when Instagram
 * cannot be asked. Posted means a published scheduled post of the variant's
 * export. Each variant is asked at most once every ten minutes, counted from
 * the last attempt whatever came of it, so a failing read is not repeated on
 * every load; `live: false` (the page refreshing itself while exports
 * render) asks nothing and shows what is stored. The token is the one the
 * comment replies use, so this stays a handful of calls an hour.
 */
export async function refreshVariantInsights(
  workspaceId: string,
  set: VariantSet,
  options: { live: boolean; now?: Date } = { live: true },
): Promise<{ state: InsightsState; winner: string | null; numbers: Map<string, VariantNumbers> }> {
  const now = options.now ?? new Date();
  const posts = await prisma.scheduledPost.findMany({
    where: { workspaceId, status: "PUBLISHED", mediaId: { not: null }, renderJob: { reelId: { in: set.variants.map((variant) => variant.reelId) } } },
    orderBy: { publishedAt: "desc" },
    select: { mediaId: true, publishedAt: true, renderJob: { select: { reelId: true } } },
  });
  const postFor = new Map<string, { mediaId: string; publishedAt: Date | null }>();
  for (const post of posts) {
    if (post.renderJob.reelId && post.mediaId && !postFor.has(post.renderJob.reelId)) postFor.set(post.renderJob.reelId, { mediaId: post.mediaId, publishedAt: post.publishedAt });
  }

  const numbers = new Map<string, VariantNumbers>(
    set.variants.map((variant) => {
      const post = postFor.get(variant.reelId);
      // Numbers stored for an earlier post of this variant are not this post's.
      const same = post !== undefined && variant.mediaId === post.mediaId;
      return [variant.reelId, { views: same ? variant.views : null, reach: same ? variant.reach : null, insightsAt: same ? variant.insightsAt : null, postedAt: post?.publishedAt ?? null }];
    }),
  );
  if (postFor.size === 0) return { state: "unposted", winner: null, numbers };

  let permission = false;
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } }, select: { messagingToken: true } });
  const token = account?.messagingToken;
  if (token && options.live) {
    const due = set.variants.filter((variant) => {
      const post = postFor.get(variant.reelId);
      if (!post) return false;
      return variant.mediaId !== post.mediaId || !variant.insightsCheckedAt || now.getTime() - variant.insightsCheckedAt.getTime() > INSIGHTS_TTL_MS;
    });
    const read = await Promise.all(due.map(async (variant) => [variant, await postInsights(token, postFor.get(variant.reelId)!.mediaId)] as const));
    for (const [variant, insights] of read) {
      const mediaId = postFor.get(variant.reelId)!.mediaId;
      if (insights === "permission") permission = true;
      if (insights && insights !== "permission") {
        await prisma.reelVariant.update({ where: { reelId: variant.reelId }, data: { views: insights.views, reach: insights.reach, mediaId, insightsAt: now, insightsCheckedAt: now } });
        numbers.set(variant.reelId, { ...numbers.get(variant.reelId)!, views: insights.views, reach: insights.reach, insightsAt: now });
      } else {
        // A failed read counts too: the next try is ten minutes away, not on the next load.
        const moved = variant.mediaId !== mediaId;
        await prisma.reelVariant.update({ where: { reelId: variant.reelId }, data: { mediaId, insightsCheckedAt: now, ...(moved ? { views: null, reach: null, insightsAt: null } : {}) } });
      }
    }
  }
  const counted = [...numbers.values()].some((n) => n.views !== null || n.reach !== null);
  const state: InsightsState = permission ? "permission" : counted ? "read" : !token ? "no-connection" : "waiting";
  const winner = variantWinner([...numbers.entries()].map(([reelId, n]) => ({ reelId, views: n.views, reach: n.reach })));
  return { state, winner, numbers };
}

type ExportableReel = { updatedAt: Date; renderJobs: { status: string; createdAt: Date }[] };

/** A variant needs an export when it has none, its last one failed, or it was edited after its last one. */
export function needsExport(reel: ExportableReel): boolean {
  const last = reel.renderJobs[0];
  return !last || last.status === "FAILED" || last.createdAt < reel.updatedAt;
}

/** What Export all would use, for its confirmation: exports left this month (null: no cap) and how many more may render at once. */
export async function exportAllAllowance(workspaceId: string): Promise<{ remaining: number | null; atOnce: number }> {
  const [{ plan }, used, unlimited, active] = await Promise.all([
    workspacePlan(workspaceId),
    exportsThisMonth(workspaceId),
    isUnlimited(workspaceId),
    prisma.renderJob.count({ where: { workspaceId, kind: { not: "PREVIEW" }, status: { in: ["QUEUED", "RUNNING"] } } }),
  ]);
  return { remaining: unlimited ? null : Math.max(0, plan.exportsPerMonth - used), atOnce: Math.max(0, plan.activeExports - active) };
}

export type ExportAllResult = { queued: number; refused: string | null; busy?: true };

/**
 * Export all: queues an export of each variant that needs one, at most
 * `confirmed` (the number the studio was shown and agreed to). A
 * per-workspace advisory lock, held for the whole loop, means two tabs or a
 * double tap cannot both run it and overshoot the plan's limits; the second
 * is told it is already running. Each export goes through the same checks
 * and limits as Export; the first refusal stops the loop and is reported.
 * Null when the set is gone.
 */
export async function exportVariantSet(user: { id: string; workspaceId: string }, groupId: string, confirmed: number): Promise<ExportAllResult | null> {
  const key = `export-all:${user.workspaceId}`;
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${key}::text)) AS locked`;
      if (!locked) return { queued: 0, refused: "Export all is already starting these, in another tab or from a second tap.", busy: true as const };
      const group = await prisma.variantGroup.findFirst({
        where: { id: groupId, workspaceId: user.workspaceId },
        include: { variants: { include: { reel: { select: { id: true, updatedAt: true, renderJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, createdAt: true } } } } } } },
      });
      if (!group) return null;
      let queued = 0;
      let refused: string | null = null;
      for (const variant of group.variants) {
        if (queued >= confirmed) break;
        if (!needsExport(variant.reel)) continue;
        const result = await queueReelExport(user, variant.reel.id);
        if (result.ok) {
          queued++;
          continue;
        }
        refused = result.message || result.issues.map((issue) => issue.message).join(" ") || "An export could not start.";
        break;
      }
      return { queued, refused };
    },
    // The lock is held while the exports are queued: a few seconds each, with the worker start.
    { timeout: 60_000, maxWait: 10_000 },
  );
}
