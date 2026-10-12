"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { INSTAGRAM, parseInstagramAudioChoice, publishAtProblem, zonedLocalToUtc } from "@reelwalk/core";
import { cancelScheduledPost as cancelPost, prisma, setScheduledPostAudio } from "@reelwalk/db";
import { COVER_FRAME_MS } from "@/lib/instagram";
import { postingProblem } from "@/lib/scheduled-posts";
import { getCurrentUser } from "@/lib/workspace";

/** Queued posts a studio may have waiting at once: a few months of daily posts. */
const MAX_WAITING = 120;

export type ScheduleResult = { ok: true; id: string; publishAt: string } | { ok: false; error: string };

/**
 * Queues a finished export to be posted as a Reel at a wall-clock time in
 * the viewer's time zone. The caption is the reel's, as saved right now.
 */
export async function schedulePost(input: { jobId: string; local: string; timeZone: string; audio?: unknown }): Promise<ScheduleResult> {
  const user = await getCurrentUser();
  const problem = await postingProblem(user.workspaceId);
  if (problem) return { ok: false, error: problem };
  const audio = input.audio == null ? null : parseInstagramAudioChoice(input.audio);
  if (input.audio != null && !audio) return { ok: false, error: "That Instagram sound could not be read. Pick it again." };

  const publishAt = zonedLocalToUtc(String(input.local), String(input.timeZone));
  if (!publishAt) return { ok: false, error: "Pick a date and time." };
  const tooSoonOrFar = publishAtProblem(publishAt, new Date());
  if (tooSoonOrFar) return { ok: false, error: tooSoonOrFar };

  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } } });
  if (!account) return { ok: false, error: "Connect an Instagram professional account first (Account tab)." };
  if (account.expiresAt && account.expiresAt.getTime() < publishAt.getTime()) {
    return { ok: false, error: "Your Instagram connection runs out before then. Reconnect it on the Account tab, then schedule." };
  }

  const job = await prisma.renderJob.findFirst({
    where: { id: String(input.jobId), workspaceId: user.workspaceId, status: "SUCCEEDED", output: { isNot: null } },
    include: { reel: { select: { id: true, caption: true } } },
  });
  if (!job) return { ok: false, error: "This export has not finished." };
  const caption = job.reel?.caption ?? job.caption ?? "";
  if (caption.length > INSTAGRAM.captionMaxChars) return { ok: false, error: `Captions can be ${INSTAGRAM.captionMaxChars} characters.` };

  const waiting = await prisma.scheduledPost.count({ where: { workspaceId: user.workspaceId, status: { in: ["SCHEDULED", "PUBLISHING"] } } });
  if (waiting >= MAX_WAITING) return { ok: false, error: `You have ${waiting} posts waiting. Cancel one, or wait for some to go out.` };

  const post = await prisma.scheduledPost.create({
    data: {
      workspaceId: user.workspaceId,
      renderJobId: job.id,
      createdById: user.id,
      caption,
      coverMs: COVER_FRAME_MS,
      publishAt,
      ...(audio
        ? { audioId: audio.audioId, audioTitle: audio.title, audioArtist: audio.artist, audioVolume: audio.audioVolume, videoVolume: audio.videoVolume }
        : {}),
    },
  });
  revalidatePath("/scheduled");
  return { ok: true, id: post.id, publishAt: publishAt.toISOString() };
}

/** Cancels a post that is still waiting. One already publishing cannot be stopped. */
export async function cancelScheduled(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const cancelled = await cancelPost(prisma, { id: String(formData.get("id") ?? ""), workspaceId: user.workspaceId });
  revalidatePath("/scheduled");
  redirect(cancelled ? "/scheduled?cancelled=1" : "/scheduled?cancelled=late");
}

export type SoundResult = { ok: true } | { ok: false; error: string };

/**
 * Changes (audio set) or removes (audio null) the Instagram sound of a post
 * that is still waiting. One already publishing keeps what it had.
 */
export async function setScheduledSound(input: { id: string; audio: unknown }): Promise<SoundResult> {
  const user = await getCurrentUser();
  const audio = input.audio == null ? null : parseInstagramAudioChoice(input.audio);
  if (input.audio != null && !audio) return { ok: false, error: "That Instagram sound could not be read. Pick it again." };
  const changed = await setScheduledPostAudio(prisma, { id: String(input.id ?? ""), workspaceId: user.workspaceId, audio });
  revalidatePath("/scheduled");
  return changed ? { ok: true } : { ok: false, error: "That post has already started going out, so its sound can no longer change." };
}
