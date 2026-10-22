"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { INSTAGRAM, parseInstagramAudioChoice, POST_SPACING_MS, publishAtProblem, spacingWarning, zonedLocalToUtc } from "@reelwalk/core";
import { cancelScheduledPost as cancelPost, prisma, setScheduledPostAudio } from "@reelwalk/db";
import { mediaUrl } from "@/lib/storage";
import { ensureStoryCut, postableJob, reelPostData, storyPostData } from "@/lib/posting";
import { postingProblem } from "@/lib/scheduled-posts";
import { getCurrentUser } from "@/lib/workspace";
import { postAnywayLine, postGate } from "@/lib/render-verify";

/** Queued posts a studio may have waiting at once: a few months of daily posts. */
const MAX_WAITING = 120;

export type ScheduleResult =
  | { ok: true; id: string; publishAt: string; storyId: string | null; storyError: string | null }
  /** `spacing`: the refusal is the spacing guard (ADR 0065); sending `confirmSpacing` schedules anyway. */
  | { ok: false; error: string; spacing?: true; blocked?: string[] };

/**
 * Other posts and stories of the account near a time, for the spacing guard
 * (ADR 0065). Posts that went out, are going out or are waiting all count; a
 * story following a reel is at that reel's time and is counted once, as the reel.
 */
async function neighbours(workspaceId: string, publishAt: Date, except: string[] = []) {
  const rows = await prisma.scheduledPost.findMany({
    where: {
      workspaceId,
      id: { notIn: except },
      status: { in: ["SCHEDULED", "PUBLISHING", "PUBLISHED"] },
      publishAt: { gte: new Date(publishAt.getTime() - POST_SPACING_MS), lte: new Date(publishAt.getTime() + POST_SPACING_MS) },
    },
    select: { kind: true, afterPostId: true, publishAt: true, renderJob: { select: { reel: { select: { title: true } }, sourceJob: { select: { reel: { select: { title: true } } } } } } },
  });
  return rows
    .filter((row) => !(row.kind === "STORY" && row.afterPostId))
    .map((row) => ({ publishAt: row.publishAt, kind: row.kind, title: row.renderJob.reel?.title ?? row.renderJob.sourceJob?.reel?.title ?? null }));
}

/**
 * Queues a finished export to be posted as a Reel at a wall-clock time in
 * the viewer's time zone, and with `story` (the default) a story cut of its
 * opening right after it. The caption is the reel's, as saved right now.
 */
export async function schedulePost(input: {
  jobId: string;
  local: string;
  timeZone: string;
  audio?: unknown;
  aiGenerated?: boolean;
  story?: boolean;
  confirmSpacing?: boolean;
  postAnyway?: boolean;
}): Promise<ScheduleResult> {
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

  const job = await postableJob(user.workspaceId, String(input.jobId));
  if (!job) return { ok: false, error: "This export has not finished." };
  // The render checks (ADR 0071) stop a scheduled post the same way as an immediate one.
  const gate = await postGate(job);
  if (gate.blocked && !input.postAnyway) return { ok: false, error: gate.reason ?? "This export failed its checks.", blocked: gate.reasons };
  if (gate.blocked) console.warn(postAnywayLine({ jobId: job.id, userId: user.id, action: "schedule", reasons: gate.reasons }));
  const caption = job.reel?.caption ?? job.caption ?? "";
  if (caption.length > INSTAGRAM.captionMaxChars) return { ok: false, error: `Captions can be ${INSTAGRAM.captionMaxChars} characters.` };

  const waiting = await prisma.scheduledPost.count({ where: { workspaceId: user.workspaceId, status: { in: ["SCHEDULED", "PUBLISHING"] } } });
  if (waiting >= MAX_WAITING) return { ok: false, error: `You have ${waiting} posts waiting. Cancel one, or wait for some to go out.` };

  if (!input.confirmSpacing) {
    const warning = spacingWarning(publishAt, await neighbours(user.workspaceId, publishAt));
    if (warning) return { ok: false, error: `${warning[0].toUpperCase()}${warning.slice(1)}`, spacing: true };
  }

  const story = input.story !== false;
  let cut: { id: string } | null = null;
  let storyError: string | null = null;
  if (story) {
    try {
      cut = await ensureStoryCut(user, job, account.username);
    } catch (error) {
      storyError = `The story could not be made: ${error instanceof Error ? error.message : "unknown error"}. The reel is scheduled without one.`;
    }
  }
  const aiGenerated = input.aiGenerated === true;
  const { post, storyPost } = await prisma.$transaction(async (tx) => {
    const post = await tx.scheduledPost.create({ data: reelPostData(user, job, { publishAt, audio, aiGenerated }) });
    const storyPost = cut ? await tx.scheduledPost.create({ data: storyPostData(user, { renderJobId: cut.id, publishAt, afterPostId: post.id, aiGenerated }) }) : null;
    return { post, storyPost };
  });
  revalidatePath("/scheduled");
  return { ok: true, id: post.id, publishAt: publishAt.toISOString(), storyId: storyPost?.id ?? null, storyError };
}

/** Cancels a post that is still waiting (and the story waiting to follow it). One already publishing cannot be stopped. */
export async function cancelScheduled(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const cancelled = await cancelPost(prisma, { id: String(formData.get("id") ?? ""), workspaceId: user.workspaceId });
  revalidatePath("/scheduled");
  redirect(cancelled ? "/scheduled?cancelled=1" : "/scheduled?cancelled=late");
}

export type StoryToggleResult = { ok: true; storyId: string | null } | { ok: false; error: string };

/**
 * Adds a story to a waiting reel post (its cut is rendered now, and goes out
 * right after the reel), or drops the one waiting. A reel already going out
 * keeps what it had.
 */
export async function setScheduledStory(input: { id: string; story: boolean }): Promise<StoryToggleResult> {
  const user = await getCurrentUser();
  const post = await prisma.scheduledPost.findFirst({
    where: { id: String(input.id ?? ""), workspaceId: user.workspaceId, kind: "REEL" },
    include: { stories: { where: { status: { in: ["SCHEDULED", "PUBLISHING"] } }, select: { id: true, status: true } } },
  });
  if (!post) return { ok: false, error: "That post is gone." };
  if (post.status !== "SCHEDULED") return { ok: false, error: "That post has already started going out, so its story can no longer change." };
  const current = post.stories[0] ?? null;
  if (!input.story) {
    if (current) await cancelPost(prisma, { id: current.id, workspaceId: user.workspaceId });
    revalidatePath("/scheduled");
    return { ok: true, storyId: null };
  }
  if (current) return { ok: true, storyId: current.id };
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } }, select: { username: true } });
  const job = await postableJob(user.workspaceId, post.renderJobId);
  if (!account || !job) return { ok: false, error: "The export this post was made from is gone." };
  try {
    const cut = await ensureStoryCut(user, job, account.username);
    const story = await prisma.scheduledPost.create({
      data: storyPostData(user, { renderJobId: cut.id, publishAt: post.publishAt, afterPostId: post.id, aiGenerated: post.aiGenerated }),
      select: { id: true },
    });
    revalidatePath("/scheduled");
    return { ok: true, storyId: story.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The story could not be made." };
  }
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

/** Sign only the requested queued export, after checking workspace ownership. */
export async function scheduledSoundPreview(id: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  const post = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId: user.workspaceId, status: "SCHEDULED" },
    select: { renderJob: { select: { output: { select: { objectKey: true } } } } },
  });
  const key = post?.renderJob.output?.objectKey;
  if (!key) return { ok: false, error: "This post is no longer waiting, or its export is unavailable." };
  return { ok: true, url: await mediaUrl(key) };
}
