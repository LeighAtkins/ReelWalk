import { prisma, runScheduledPosts, type ScheduledPost, type ScheduledPostDeps, type TickResult } from "@reelwalk/db";
import { emailHtml, sendEmail } from "./email";
import { containerStatus, createReelContainer, createStoryContainer, isFakeInstagram, isInstagramConfigured, isTransientInstagramError, publishContainer } from "./instagram";
import { workspacePlan } from "./plans";
import { outputUrls } from "./render-jobs";

/**
 * The web app's side of the scheduled post publisher (ADR 0017): the
 * Instagram calls, the plan gate, the video URL and the failure email. The
 * claim and state machine live in @reelwalk/db (scheduled-posts.ts).
 *
 * Two things call a tick: a loop in every web server process
 * (instrumentation.ts, every 60 s) and POST /api/scheduled-posts/run, which
 * EventBridge calls every minute on AWS because App Runner gives an instance
 * almost no CPU between requests. The claim makes running both harmless.
 */

/** A video URL Instagram's servers cannot fetch: the local stack's MinIO. */
export function isLocalMediaUrl(url: string): boolean {
  return /localhost|127\.0\.0\.1|minio:/.test(url);
}

/** The reason a workspace may not post to Instagram from here, or null when it may. */
export async function postingProblem(workspaceId: string): Promise<string | null> {
  if (!isInstagramConfigured() && !isFakeInstagram()) return "Instagram posting is switched off on this deployment.";
  if (!(await workspacePlan(workspaceId)).plan.instagram) return "Posting straight to Instagram comes with the Agent plan.";
  return null;
}

async function prepare(post: ScheduledPost): Promise<{ igUserId: string; token: string; videoUrl: string } | string> {
  const problem = await postingProblem(post.workspaceId);
  if (problem) return problem;
  if (isFakeInstagram()) return "This stack has a pretend Instagram connection (DEV_FAKE_INSTAGRAM), so nothing was posted.";
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: post.workspaceId, provider: "instagram" } } });
  if (!account || (account.expiresAt && account.expiresAt.getTime() < Date.now())) {
    return "Instagram is no longer connected. Reconnect it on the Account tab, then schedule the post again.";
  }
  const job = await prisma.renderJob.findFirst({ where: { id: post.renderJobId, status: "SUCCEEDED" }, include: { output: true } });
  // Fresh every time: a presigned URL (no CloudFront) lasts an hour.
  const urls = job ? await outputUrls(job) : null;
  if (!urls) return "The export this post was made from is gone.";
  if (isLocalMediaUrl(urls.playUrl)) return "Instagram cannot fetch a video from this local stack.";
  return { igUserId: account.externalId, token: account.accessToken, videoUrl: urls.playUrl };
}

/** Tells the studio's owner (its first user) that a post did not go out. */
async function notifyFailed(post: ScheduledPost): Promise<void> {
  // The person who made the post, else the workspace's first owner (ADR 0079: a workspace may belong to someone whose home it is not).
  const maker = post.createdById ? await prisma.user.findUnique({ where: { id: post.createdById }, select: { email: true, name: true } }) : null;
  const owner = maker ?? (await prisma.user.findFirst({ where: { OR: [{ workspaceId: post.workspaceId }, { memberships: { some: { workspaceId: post.workspaceId, role: "OWNER" } } }] }, orderBy: { createdAt: "asc" }, select: { email: true, name: true } }));
  if (!owner) return;
  const when = `${post.publishAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const base = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  const reason = post.error ?? "Instagram did not accept it.";
  const what = post.kind === "STORY" ? "Story" : "Reel";
  const paragraphs = [
    `Hi ${owner.name}, the ${what} you scheduled for ${when} was not posted to Instagram.`,
    `What went wrong: ${reason}`,
    post.kind === "STORY" ? "Nothing was published. You can post the story again from the export screen." : "Nothing was published. You can schedule it again from the export screen.",
  ];
  await sendEmail({
    to: owner.email,
    subject: `A scheduled Instagram ${post.kind === "STORY" ? "story" : "post"} did not go out`,
    text: `${paragraphs.join("\n\n")}\n\n${base}/scheduled`,
    html: emailHtml({ heading: "A scheduled post did not go out", paragraphs, button: base ? { label: "See scheduled posts", url: `${base}/scheduled` } : undefined }),
  });
}

export const scheduledPostDeps: ScheduledPostDeps = {
  prepare,
  // A Story takes only the video and the AI disclosure (ADR 0065); a Reel the caption, cover and sound too.
  createContainer: (input) => (input.kind === "STORY" ? createStoryContainer(input) : createReelContainer(input)),
  containerStatus: (containerId, token) => containerStatus(containerId, token),
  publish: (igUserId, containerId, token) => publishContainer(igUserId, containerId, token),
  classify: (error) => ({
    message: error instanceof Error ? error.message : "Instagram did not answer.",
    transient: isTransientInstagramError(error),
  }),
  onFailed: notifyFailed,
};

/** One tick of the publisher. Never throws. */
export async function publishDueScheduledPosts(): Promise<TickResult | null> {
  try {
    const result = await runScheduledPosts(prisma, scheduledPostDeps);
    if (result.claimed > 0) console.log("scheduled posts:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("scheduled posts: tick failed", error);
    return null;
  }
}

