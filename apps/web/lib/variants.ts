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
import { postInsights } from "@/lib/instagram-messaging";
import { mediaScope } from "@/lib/media-scope";

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
  /** Numbers were read (or recently stored) for at least one posted variant. */
  | "read"
  /** None of the set is posted yet. */
  | "unposted"
  /** Posted, but there is no Instagram Login connection to read numbers with. */
  | "no-connection"
  /** The connection predates the insights permission: reconnect on Account. */
  | "permission";

/**
 * Reads each posted variant's numbers from Instagram (ADR 0027) and stores
 * them on the variant, so the set can be compared later even when Instagram
 * cannot be asked. Posted means a published scheduled post of the variant's
 * export. At most one request per variant every ten minutes.
 */
export async function refreshVariantInsights(workspaceId: string, set: VariantSet, now: Date = new Date()): Promise<{ state: InsightsState; winner: string | null; numbers: Map<string, { views: number | null; reach: number | null; insightsAt: Date | null }> }> {
  const posts = await prisma.scheduledPost.findMany({
    where: { workspaceId, status: "PUBLISHED", mediaId: { not: null }, renderJob: { reelId: { in: set.variants.map((variant) => variant.reelId) } } },
    orderBy: { publishedAt: "desc" },
    select: { mediaId: true, renderJob: { select: { reelId: true } } },
  });
  const mediaFor = new Map<string, string>();
  for (const post of posts) if (post.renderJob.reelId && !mediaFor.has(post.renderJob.reelId)) mediaFor.set(post.renderJob.reelId, post.mediaId!);

  const numbers = new Map(set.variants.map((variant) => [variant.reelId, { views: variant.views, reach: variant.reach, insightsAt: variant.insightsAt }]));
  let state: InsightsState = mediaFor.size === 0 ? "unposted" : "read";
  if (mediaFor.size > 0) {
    const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } }, select: { messagingToken: true } });
    const token = account?.messagingToken;
    const stale = set.variants.filter((variant) => mediaFor.has(variant.reelId) && (!variant.insightsAt || now.getTime() - variant.insightsAt.getTime() > INSIGHTS_TTL_MS || variant.mediaId !== mediaFor.get(variant.reelId)));
    if (!token) {
      if (stale.length > 0) state = "no-connection";
    } else {
      const read = await Promise.all(stale.map(async (variant) => [variant, await postInsights(token, mediaFor.get(variant.reelId)!)] as const));
      for (const [variant, insights] of read) {
        if (insights === "permission") {
          state = "permission";
          continue;
        }
        if (!insights) continue;
        const stored = { views: insights.views, reach: insights.reach, mediaId: mediaFor.get(variant.reelId)!, insightsAt: now };
        await prisma.reelVariant.update({ where: { reelId: variant.reelId }, data: stored });
        numbers.set(variant.reelId, stored);
      }
    }
  }
  const winner = variantWinner([...numbers.entries()].map(([reelId, n]) => ({ reelId, views: n.views, reach: n.reach })));
  return { state, winner, numbers };
}
