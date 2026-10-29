import { fullReelStoryProblem, parseReelExportPayload, planStoryCut, referencedAssetIds, timelineDurationMs, type ReelExportPayload } from "@reelwalk/core";
import { prisma, type Prisma, type ScheduledPost } from "@reelwalk/db";
import { COVER_FRAME_MS, reelCoverMs } from "@/lib/instagram";
import { ensureWorkerRunning } from "@/lib/render-capacity";
import { flushOutbox, queueRenderJob } from "@/lib/render-jobs";
import { publishDueScheduledPosts } from "@/lib/scheduled-posts";

/**
 * Posting to Instagram, now or later (ADR 0065). Every post is a
 * ScheduledPost row advanced by the publisher (ADR 0017) on the server; an
 * immediate post is one whose time is now. The browser only reads the row,
 * so closing the page cannot lose a post. Stories are rows of kind STORY
 * that follow their reel's row.
 */

/** A finished export of the workspace, with what posting needs from its reel. */
export async function postableJob(workspaceId: string, jobId: string) {
  return prisma.renderJob.findFirst({
    where: { id: jobId, workspaceId, status: "SUCCEEDED", output: { isNot: null }, kind: { in: ["REEL", "STORY"] } },
    include: { output: true, reel: { select: { id: true, title: true, caption: true, featureConsent: true, featureHandle: true, timeline: true } } },
  });
}
export type PostableJob = NonNullable<Awaited<ReturnType<typeof postableJob>>>;

/** The workspace's Instagram connection, when it has one that has not run out. */
export async function connectedInstagram(workspaceId: string) {
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } } });
  if (!account) return null;
  if (account.expiresAt && account.expiresAt.getTime() < Date.now()) return null;
  return account;
}

/** The reel's length, from the export's frozen timeline. */
export function exportDurationMs(job: { payload: unknown }): number {
  try {
    return timelineDurationMs(parseReelExportPayload(job.payload).timeline);
  } catch {
    return 0;
  }
}

/** Why the finished reel cannot be posted as a story as it is, or null. */
export function fullReelStoryIssue(job: { payload: unknown; output: { sizeBytes: bigint } | null }): string | null {
  return fullReelStoryProblem(exportDurationMs(job), job.output ? Number(job.output.sizeBytes) : null);
}

/** The newest story cut of an export that did not fail (rendering or done), or null. */
export async function storyCutOf(workspaceId: string, sourceJobId: string) {
  return prisma.renderJob.findFirst({
    where: { workspaceId, sourceJobId, kind: "STORY", status: { not: "FAILED" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, error: true, output: { select: { objectKey: true } } },
  });
}

/** The story cut's render payload: the opening and the plate, with only the assets they use. */
export function storyCutPayload(payload: ReelExportPayload, handle: string): ReelExportPayload {
  const cut = planStoryCut(payload.timeline, { handle });
  const used = new Set(referencedAssetIds(cut.timeline));
  const assets = Object.fromEntries(Object.entries(payload.assets).filter(([id]) => used.has(id)));
  return parseReelExportPayload({ timeline: cut.timeline, assets, output: payload.output });
}

/**
 * The story cut of an export: the one already rendering or rendered, else a
 * new STORY render job (queued like an export, outside the plan's export
 * count). The cut is made from the export's own frozen payload, so it is the
 * reel as exported, not as edited since.
 */
export async function ensureStoryCut(user: { id: string; workspaceId: string }, job: PostableJob, handle: string): Promise<{ id: string; status: string }> {
  const existing = await storyCutOf(user.workspaceId, job.id);
  if (existing) return existing;
  const payload = storyCutPayload(parseReelExportPayload(job.payload), handle);
  const created = await prisma.$transaction(async (tx) => {
    const story = await tx.renderJob.create({
      data: {
        workspaceId: user.workspaceId,
        createdById: user.id,
        kind: "STORY",
        sourceJobId: job.id,
        payload,
        caption: `${job.reel?.title ?? job.caption ?? "Reel"} · Story`,
      },
      select: { id: true, status: true, generation: true, workspaceId: true },
    });
    return { ...story, route: await queueRenderJob(tx, story) };
  });
  await flushOutbox();
  await ensureWorkerRunning(created.route);
  return { id: created.id, status: created.status };
}

export type PostAudio = { audioId: string; title: string; artist: string | null; audioVolume: number; videoVolume: number } | null;

/** The row for a Reel post of `job`, now or at `publishAt`. */
export function reelPostData(
  user: { id: string; workspaceId: string },
  job: PostableJob,
  input: { publishAt: Date; audio: PostAudio; aiGenerated: boolean },
): Prisma.ScheduledPostUncheckedCreateInput {
  const audio = input.audio;
  return {
    workspaceId: user.workspaceId,
    renderJobId: job.id,
    createdById: user.id,
    kind: "REEL",
    caption: job.reel?.caption ?? job.caption ?? "",
    coverMs: reelCoverMs(job.reel?.timeline) ?? COVER_FRAME_MS,
    publishAt: input.publishAt,
    aiGenerated: input.aiGenerated,
    ...(audio ? { audioId: audio.audioId, audioTitle: audio.title, audioArtist: audio.artist, audioVolume: audio.audioVolume, videoVolume: audio.videoVolume } : {}),
  };
}

/** The row for a Story: the video (a story cut, or a short reel itself), optionally after a reel's row. */
export function storyPostData(
  user: { id: string; workspaceId: string },
  input: { renderJobId: string; publishAt: Date; afterPostId: string | null; aiGenerated: boolean },
): Prisma.ScheduledPostUncheckedCreateInput {
  return {
    workspaceId: user.workspaceId,
    renderJobId: input.renderJobId,
    createdById: user.id,
    kind: "STORY",
    afterPostId: input.afterPostId,
    caption: "",
    coverMs: 0,
    publishAt: input.publishAt,
    aiGenerated: input.aiGenerated,
  };
}

/** A post's state for the browser. `storyPostId` is the Story row that follows a Reel; `storyError` why there is none. */
export type PostStep =
  | { state: "processing"; postId: string; storyPostId?: string; storyError?: string }
  | { state: "published"; permalink: string | null; storyPostId?: string; storyError?: string }
  /** `blocked`: the export failed a hard render check (ADR 0071); sending `postAnyway` posts it regardless, logged. */
  | { state: "failed"; error: string; blocked?: string[] };

export function postStep(post: Pick<ScheduledPost, "id" | "status" | "permalink" | "error">): PostStep {
  if (post.status === "PUBLISHED") return { state: "published", permalink: post.permalink };
  if (post.status === "FAILED") return { state: "failed", error: post.error ?? "Instagram did not accept it." };
  if (post.status === "CANCELLED") return { state: "failed", error: "This post was cancelled." };
  return { state: "processing", postId: post.id };
}

/**
 * The post as it stands, after giving the publisher a turn when the post is
 * due. The loop and EventBridge tick anyway; this just makes an open page
 * see progress within seconds rather than a minute, and nothing depends on
 * it being called.
 */
export async function advancePost(workspaceId: string, postId: string, now: Date = new Date()): Promise<PostStep> {
  const post = await prisma.scheduledPost.findFirst({ where: { id: postId, workspaceId } });
  if (!post) return { state: "failed", error: "Unknown post." };
  const due = post.status === "SCHEDULED" ? post.publishAt.getTime() <= now.getTime() : post.status === "PUBLISHING" && post.nextCheckAt !== null && post.nextCheckAt.getTime() <= now.getTime();
  if (!due) return postStep(post);
  await publishDueScheduledPosts();
  const after = await prisma.scheduledPost.findFirst({ where: { id: postId, workspaceId } });
  return postStep(after ?? post);
}
