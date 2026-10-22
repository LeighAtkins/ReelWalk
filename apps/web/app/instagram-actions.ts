"use server";

import { redirect } from "next/navigation";
import { prisma } from "@reelwalk/db";
import { parseInstagramAudioChoice } from "@reelwalk/core";
import { isInstagramConfigured } from "@/lib/instagram";
import { outputUrls } from "@/lib/render-jobs";
import { workspacePlan } from "@/lib/plans";
import { isLocalMediaUrl, publishDueScheduledPosts } from "@/lib/scheduled-posts";
import { advancePost, connectedInstagram, ensureStoryCut, fullReelStoryIssue, postableJob, postStep, reelPostData, storyPostData, type PostStep } from "@/lib/posting";
import { getCurrentUser } from "@/lib/workspace";

export type { PostStep } from "@/lib/posting";

export async function disconnectInstagram(): Promise<void> {
  const user = await getCurrentUser();
  await prisma.socialAccount.deleteMany({ where: { workspaceId: user.workspaceId, provider: "instagram" } });
  redirect("/account?instagram=disconnected");
}

/** The checks every immediate post makes, and what it needs; a string is the refusal. */
async function readyToPost(jobId: string) {
  const user = await getCurrentUser();
  if (!isInstagramConfigured()) return "Instagram posting is not set up on this deployment.";
  if (!(await workspacePlan(user.workspaceId)).plan.instagram) return "Posting straight to Instagram comes with the Agent plan.";
  const account = await connectedInstagram(user.workspaceId);
  if (!account) return "Connect an Instagram professional account first (Account tab).";
  const job = await postableJob(user.workspaceId, jobId);
  const urls = job ? await outputUrls(job) : null;
  if (!job || !urls) return "This export has not finished.";
  if (isLocalMediaUrl(urls.playUrl)) return "Instagram cannot fetch a video from this local stack. Posting works once media is on S3 or CloudFront.";
  return { user, account, job };
}

/**
 * Posts a finished export as a Reel, now (ADR 0065): the post is a row the
 * server-side publisher advances, so it goes out even if this page is closed
 * straight away. With `story`, a story cut of the reel's opening is rendered
 * and posted as a Story right after the Reel is published. The first step
 * (asking Instagram to fetch the video) is taken before answering.
 */
export async function startInstagramPost(input: { jobId: string; audio?: unknown; aiGenerated?: boolean; story?: boolean }): Promise<PostStep> {
  const ready = await readyToPost(String(input.jobId));
  if (typeof ready === "string") return { state: "failed", error: ready };
  const { user, account, job } = ready;
  const audio = input.audio == null ? null : parseInstagramAudioChoice(input.audio);
  if (input.audio != null && !audio) return { state: "failed", error: "That Instagram sound could not be read. Pick it again." };
  const aiGenerated = input.aiGenerated === true;

  // The cut starts rendering first, so it is ready about when the reel is published.
  let cut: { id: string } | null = null;
  let storyError: string | undefined;
  if (input.story) {
    try {
      cut = await ensureStoryCut(user, job, account.username);
    } catch (error) {
      storyError = `The story could not be made: ${error instanceof Error ? error.message : "unknown error"}. The reel is still posting.`;
    }
  }
  const now = new Date();
  const { post, story } = await prisma.$transaction(async (tx) => {
    const post = await tx.scheduledPost.create({ data: reelPostData(user, job, { publishAt: now, audio, aiGenerated }) });
    const story = cut ? await tx.scheduledPost.create({ data: storyPostData(user, { renderJobId: cut.id, publishAt: now, afterPostId: post.id, aiGenerated }) }) : null;
    return { post, story };
  });
  // A reel offered for featuring without a handle is credited to the account it was posted from.
  if (job.reel?.featureConsent && !job.reel.featureHandle) {
    await prisma.reel.update({ where: { id: job.reel.id }, data: { featureHandle: account.username } }).catch(() => undefined);
  }
  await publishDueScheduledPosts();
  const step = postStep((await prisma.scheduledPost.findFirst({ where: { id: post.id } })) ?? post);
  if (step.state === "failed") return step;
  return { ...step, ...(story ? { storyPostId: story.id } : {}), ...(storyError ? { storyError } : {}) };
}

/** Called every few seconds by the export screen until the post is published or fails. Nothing depends on it being called. */
export async function continueInstagramPost(input: { postId: string }): Promise<PostStep> {
  const user = await getCurrentUser();
  return advancePost(user.workspaceId, String(input.postId));
}

/**
 * Posts a Story now from a finished export (ADR 0065): its story cut (the
 * opening and the plate, rendered first when it is not yet), or the whole
 * reel when it is no longer than Instagram's 60 s.
 */
export async function startInstagramStory(input: { jobId: string; source: "cut" | "full"; aiGenerated?: boolean }): Promise<PostStep> {
  const ready = await readyToPost(String(input.jobId));
  if (typeof ready === "string") return { state: "failed", error: ready };
  const { user, account, job } = ready;
  const aiGenerated = input.aiGenerated === true;
  let renderJobId = job.id;
  if (input.source === "full") {
    const issue = fullReelStoryIssue(job);
    if (issue) return { state: "failed", error: issue };
  } else {
    try {
      renderJobId = (await ensureStoryCut(user, job, account.username)).id;
    } catch (error) {
      return { state: "failed", error: error instanceof Error ? error.message : "The story cut could not be made." };
    }
  }
  const post = await prisma.scheduledPost.create({ data: storyPostData(user, { renderJobId, publishAt: new Date(), afterPostId: null, aiGenerated }) });
  await publishDueScheduledPosts();
  return postStep((await prisma.scheduledPost.findFirst({ where: { id: post.id } })) ?? post);
}
