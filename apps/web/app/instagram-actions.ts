"use server";

import { redirect } from "next/navigation";
import { prisma } from "@reelwalk/db";
import { containerStatus, createReelContainer, isInstagramConfigured, publishContainer } from "@/lib/instagram";
import { outputUrls } from "@/lib/render-jobs";
import { getCurrentUser } from "@/lib/workspace";

export async function disconnectInstagram(): Promise<void> {
  const user = await getCurrentUser();
  await prisma.socialAccount.deleteMany({ where: { workspaceId: user.workspaceId, provider: "instagram" } });
  redirect("/account?instagram=disconnected");
}

export type PostStep =
  | { state: "processing"; containerId: string }
  | { state: "published"; permalink: string | null }
  | { state: "failed"; error: string };

async function connectedAccount(workspaceId: string) {
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } } });
  if (!account) return null;
  if (account.expiresAt && account.expiresAt.getTime() < Date.now()) return null;
  return account;
}

/**
 * Starts posting a finished export as a Reel. Instagram fetches the video
 * from a public URL (CloudFront, or a presigned link on real S3), so this only
 * works where the bucket is reachable from the internet.
 */
export async function startInstagramPost(input: { jobId: string }): Promise<PostStep> {
  const user = await getCurrentUser();
  if (!isInstagramConfigured()) return { state: "failed", error: "Instagram posting is not set up on this deployment." };
  const account = await connectedAccount(user.workspaceId);
  if (!account) return { state: "failed", error: "Connect an Instagram professional account first (Account tab)." };

  const job = await prisma.renderJob.findFirst({
    where: { id: input.jobId, workspaceId: user.workspaceId, status: "SUCCEEDED" },
    include: { output: true, reel: { select: { caption: true } } },
  });
  const urls = job ? await outputUrls(job) : null;
  if (!job || !urls) return { state: "failed", error: "This export has not finished." };
  if (/localhost|127\.0\.0\.1|minio:/.test(urls.playUrl)) {
    return { state: "failed", error: "Instagram cannot fetch a video from this local stack. Posting works once media is on S3 or CloudFront." };
  }

  try {
    const containerId = await createReelContainer({
      igUserId: account.externalId,
      token: account.accessToken,
      videoUrl: urls.playUrl,
      caption: job.reel?.caption ?? "",
    });
    return { state: "processing", containerId };
  } catch (error) {
    return { state: "failed", error: error instanceof Error ? error.message : "Instagram refused the video." };
  }
}

/** Called every few seconds by the export screen until the Reel is published or fails. */
export async function continueInstagramPost(input: { containerId: string }): Promise<PostStep> {
  const user = await getCurrentUser();
  const account = await connectedAccount(user.workspaceId);
  if (!account) return { state: "failed", error: "Instagram is no longer connected." };
  if (!/^\d{5,40}$/.test(input.containerId)) return { state: "failed", error: "Unknown post." };

  try {
    const { status, detail } = await containerStatus(input.containerId, account.accessToken);
    if (status === "IN_PROGRESS") return { state: "processing", containerId: input.containerId };
    if (status === "FINISHED") {
      const { permalink } = await publishContainer(account.externalId, input.containerId, account.accessToken);
      return { state: "published", permalink };
    }
    if (status === "PUBLISHED") return { state: "published", permalink: null };
    return { state: "failed", error: detail ?? `Instagram reported ${status}.` };
  } catch (error) {
    return { state: "failed", error: error instanceof Error ? error.message : "Instagram did not answer." };
  }
}
