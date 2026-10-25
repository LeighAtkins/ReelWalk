import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, RenderJobStatus, ScheduledPost, ScheduledPostStatus } from "./generated/prisma/client";

/**
 * The scheduled Instagram post publisher (ADR 0017).
 *
 * A tick claims due posts and moves each one a step: create the Instagram
 * media container, check on it, publish it. Instagram can take minutes to
 * process a video, so a tick never waits for it: the container id is stored
 * and the post is checked again on a later tick, possibly by another
 * instance.
 *
 * Exclusion is a compare-and-set on `claimToken`. A claim writes a fresh
 * token, and every later write is conditional on it, so of two instances
 * racing for the same row exactly one wins, and an instance whose claim was
 * taken over (after 15 minutes without progress) cannot overwrite the new
 * owner's work.
 */

/** Transient failures are retried this many times; the next one fails the post. */
export const SCHEDULED_POST_MAX_RETRIES = 3;
/** A claim with no progress for this long is abandoned and may be taken over. */
export const SCHEDULED_POST_STUCK_MS = 15 * 60_000;
/** Instagram normally processes a Reel in under five minutes; past this the container is given up. */
export const SCHEDULED_POST_CONTAINER_TIMEOUT_MS = 30 * 60_000;
/** A post first picked up later than this after its time is failed rather than posted out of the blue. */
export const SCHEDULED_POST_MAX_LATENESS_MS = 24 * 60 * 60_000;
/** A story waiting for its reel, or for its own cut to render, is looked at again after this (ADR 0065). */
export const STORY_WAIT_MS = 30_000;
/** A story whose cut is still not rendered this long after its time is failed: something is wrong with the render. */
export const STORY_RENDER_TIMEOUT_MS = 60 * 60_000;

export type StoryGate = { go: true } | { go: false; wait: true } | { go: false; wait: false; error: string };

/**
 * Whether a story may start, from the state of the reel post it follows
 * (ADR 0065): only once that is PUBLISHED; never if it failed or was
 * cancelled; otherwise wait.
 */
export function storyGate(parent: ScheduledPostStatus | null): StoryGate {
  if (parent === null) return { go: false, wait: false, error: "The reel this story was to follow is gone, so the story was not posted." };
  if (parent === "PUBLISHED") return { go: true };
  if (parent === "FAILED" || parent === "CANCELLED") {
    return { go: false, wait: false, error: parent === "FAILED" ? "The reel this story follows was not posted, so the story was not posted either." : "The reel this story follows was cancelled, so the story was too." };
  }
  return { go: false, wait: true };
}

/**
 * Whether the post's video exists yet: a story cut renders after the post is
 * made, so a story may be due before its file is. Waits while the render is
 * going, within `STORY_RENDER_TIMEOUT_MS` of the post's time.
 */
export function renderGate(job: { status: RenderJobStatus; error: string | null } | null, lateMs: number): StoryGate {
  if (job === null) return { go: false, wait: false, error: "The export this post was made from is gone." };
  if (job.status === "SUCCEEDED") return { go: true };
  if (job.status === "FAILED") return { go: false, wait: false, error: `The story cut did not render${job.error ? `: ${job.error}` : "."}` };
  if (lateMs > STORY_RENDER_TIMEOUT_MS) return { go: false, wait: false, error: "The story cut was still rendering an hour after the post's time, so it was not posted." };
  return { go: false, wait: true };
}

/**
 * Every legal status change.
 *
 * SCHEDULED  -> PUBLISHING  claimed by the publisher at publishAt
 * SCHEDULED  -> CANCELLED   cancelled by the studio
 * PUBLISHING -> PUBLISHING  re-claimed for the next container check or retry
 * PUBLISHING -> PUBLISHED   Instagram published it
 * PUBLISHING -> FAILED      a permanent error, or retries exhausted
 */
const TRANSITIONS: Record<ScheduledPostStatus, readonly ScheduledPostStatus[]> = {
  SCHEDULED: ["PUBLISHING", "CANCELLED"],
  PUBLISHING: ["PUBLISHING", "PUBLISHED", "FAILED"],
  PUBLISHED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionScheduledPost(from: ScheduledPostStatus, to: ScheduledPostStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Wait before retry n (1-based): 1, 2, then 4 minutes. */
export function scheduledPostRetryDelayMs(retry: number): number {
  return 60_000 * 2 ** Math.max(0, retry - 1);
}

/** Wait before the next container check: half the time spent so far, between 20 s and 5 min. */
export function containerRecheckDelayMs(elapsedMs: number): number {
  return Math.min(5 * 60_000, Math.max(20_000, Math.round(elapsedMs / 2)));
}

export type PublishFailure = { message: string; transient: boolean };

export type FailureStep =
  | { status: "PUBLISHING"; attempts: number; error: string; nextCheckAt: Date }
  | { status: "FAILED"; attempts: number; error: string };

/** What a failed try leads to: a retry with backoff, or FAILED. */
export function afterFailure(attempts: number, failure: PublishFailure, now: Date): FailureStep {
  const next = attempts + 1;
  if (!failure.transient || next > SCHEDULED_POST_MAX_RETRIES) {
    const suffix = failure.transient ? ` (gave up after ${next} tries)` : "";
    return { status: "FAILED", attempts: next, error: `${failure.message}${suffix}`.slice(0, 2000) };
  }
  return {
    status: "PUBLISHING",
    attempts: next,
    error: failure.message.slice(0, 2000),
    nextCheckAt: new Date(now.getTime() + scheduledPostRetryDelayMs(next)),
  };
}

export type ContainerState = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

/** A sound from Instagram's library to attach when the container is created (ADR 0018). */
export type ScheduledPostAudio = { audioId: string; audioVolume: number; videoVolume: number };

/** The post's chosen sound, or null when it has none. Volumes default to the sound replacing the reel's own audio. */
export function scheduledPostAudio(post: Pick<ScheduledPost, "audioId" | "audioVolume" | "videoVolume">): ScheduledPostAudio | null {
  if (!post.audioId) return null;
  return { audioId: post.audioId, audioVolume: post.audioVolume ?? 100, videoVolume: post.videoVolume ?? 0 };
}

/** The sound's name for messages: "Title · Artist" in quotes, or its id when the title is missing. */
export function scheduledPostAudioName(post: Pick<ScheduledPost, "audioId" | "audioTitle" | "audioArtist">): string {
  const title = post.audioTitle ? (post.audioArtist ? `${post.audioTitle} · ${post.audioArtist}` : post.audioTitle) : (post.audioId ?? "");
  return `"${title}"`;
}

/**
 * Everything the publisher needs from outside the database. The web app
 * passes the Instagram Graph calls, the storage URL and the mailer; tests
 * pass fakes.
 */
export type ScheduledPostDeps = {
  /**
   * Checks the post may still go out (plan, connection, finished export) and
   * returns what posting needs. A string is a permanent refusal, in words.
   */
  prepare(post: ScheduledPost): Promise<{ igUserId: string; token: string; videoUrl: string } | string>;
  createContainer(input: {
    /** A Reel to the feed, or a Story (ADR 0065): the Story takes only the video and the AI disclosure. */
    kind: "REEL" | "STORY";
    igUserId: string;
    token: string;
    videoUrl: string;
    caption: string;
    coverMs: number;
    /** Sent as audio_configuration; null posts the reel with its own soundtrack. */
    audio: ScheduledPostAudio | null;
    /** Sent as is_ai_generated, for Instagram's "AI info" label. */
    aiGenerated: boolean;
  }): Promise<string>;
  containerStatus(containerId: string, token: string): Promise<{ status: ContainerState; detail: string | null }>;
  publish(igUserId: string, containerId: string, token: string): Promise<{ mediaId: string; permalink: string | null }>;
  /** Whether an error thrown by the calls above is worth retrying. */
  classify(error: unknown): PublishFailure;
  /** Told once when a post ends FAILED. Its own errors are swallowed. */
  onFailed?(post: ScheduledPost): Promise<void>;
};

export type ClaimedPost = { id: string; claimToken: string };

/**
 * Claims up to `limit` posts that are due: SCHEDULED ones whose time has
 * come, and PUBLISHING ones whose next check is due (including claims
 * abandoned by a crashed instance). Each claim is a single conditional
 * UPDATE; in Postgres the second of two concurrent ones re-checks the row
 * after the first commits, sees the new token, and updates nothing.
 */
export async function claimDueScheduledPosts(prisma: PrismaClient, options: { now?: Date; limit?: number } = {}): Promise<ClaimedPost[]> {
  const now = options.now ?? new Date();
  const candidates = await prisma.scheduledPost.findMany({
    where: {
      OR: [
        { status: "SCHEDULED", publishAt: { lte: now } },
        { status: "PUBLISHING", nextCheckAt: { lte: now } },
      ],
    },
    orderBy: { publishAt: "asc" },
    take: options.limit ?? 10,
    select: { id: true, status: true, claimToken: true },
  });

  const claimed: ClaimedPost[] = [];
  for (const candidate of candidates) {
    const claimToken = randomUUID();
    const guard =
      candidate.status === "SCHEDULED"
        ? { status: "SCHEDULED" as const, publishAt: { lte: now } }
        : { status: "PUBLISHING" as const, claimToken: candidate.claimToken, nextCheckAt: { lte: now } };
    const { count } = await prisma.scheduledPost.updateMany({
      where: { id: candidate.id, ...guard },
      data: { status: "PUBLISHING", claimToken, nextCheckAt: new Date(now.getTime() + SCHEDULED_POST_STUCK_MS) },
    });
    if (count === 1) claimed.push({ id: candidate.id, claimToken });
  }
  return claimed;
}

export type StepOutcome = "published" | "waiting" | "retrying" | "failed" | "lost";

/**
 * Moves one claimed post a step. Never throws for Instagram's errors: they
 * become a retry or FAILED. Returns "lost" if the claim was taken over.
 */
export async function advanceScheduledPost(
  prisma: PrismaClient,
  claim: ClaimedPost,
  deps: ScheduledPostDeps,
  now: Date = new Date(),
): Promise<StepOutcome> {
  const post = await prisma.scheduledPost.findFirst({ where: { id: claim.id, claimToken: claim.claimToken, status: "PUBLISHING" } });
  if (!post) return "lost";

  // Every write from here on holds only while the claim is still ours.
  const write = async (data: Prisma.ScheduledPostUpdateManyMutationInput): Promise<boolean> => {
    const { count } = await prisma.scheduledPost.updateMany({ where: { id: post.id, claimToken: claim.claimToken, status: "PUBLISHING" }, data });
    return count === 1;
  };

  const fail = async (failure: PublishFailure, keepContainer: boolean): Promise<StepOutcome> => {
    const step = afterFailure(post.attempts, failure, now);
    const container = keepContainer ? {} : { containerId: null, containerAt: null };
    if (step.status === "PUBLISHING") {
      return (await write({ ...container, attempts: step.attempts, error: step.error, nextCheckAt: step.nextCheckAt })) ? "retrying" : "lost";
    }
    if (!(await write({ ...container, status: "FAILED", attempts: step.attempts, error: step.error, nextCheckAt: null }))) return "lost";
    if (deps.onFailed) {
      // Mail trouble must never undo or block the status change above.
      await deps.onFailed({ ...post, status: "FAILED", attempts: step.attempts, error: step.error }).catch((error: unknown) => {
        console.error("scheduled posts: failure notice not sent", error);
      });
    }
    return "failed";
  };

  // Posted out of the blue a day late is worse than not at all (the
  // publisher was down, or Instagram switched off on the deployment).
  if (!post.containerId && post.attempts === 0 && now.getTime() - post.publishAt.getTime() > SCHEDULED_POST_MAX_LATENESS_MS) {
    return fail({ message: "This post missed its time by more than a day, so it was not published. Schedule it again.", transient: false }, false);
  }

  try {
    // A story follows its reel (ADR 0065): not before that post is published, and never if it was not.
    if (post.afterPostId) {
      const parent = await prisma.scheduledPost.findUnique({ where: { id: post.afterPostId }, select: { status: true } });
      const gate = storyGate(parent?.status ?? null);
      if (!gate.go) {
        if (!gate.wait) return fail({ message: gate.error, transient: false }, false);
        return (await write({ nextCheckAt: new Date(now.getTime() + STORY_WAIT_MS) })) ? "waiting" : "lost";
      }
    }
    // The video may still be rendering (a story cut made when the post was): wait for it.
    if (!post.containerId) {
      const job = await prisma.renderJob.findUnique({ where: { id: post.renderJobId }, select: { status: true, error: true } });
      const gate = renderGate(job, now.getTime() - post.publishAt.getTime());
      if (!gate.go) {
        if (!gate.wait) return fail({ message: gate.error, transient: false }, false);
        return (await write({ nextCheckAt: new Date(now.getTime() + STORY_WAIT_MS) })) ? "waiting" : "lost";
      }
    }

    const ready = await deps.prepare(post);
    if (typeof ready === "string") return fail({ message: ready, transient: false }, true);

    if (!post.containerId) {
      const audio = scheduledPostAudio(post);
      let containerId: string;
      try {
        containerId = await deps.createContainer({
          kind: post.kind,
          igUserId: ready.igUserId,
          token: ready.token,
          videoUrl: ready.videoUrl,
          caption: post.caption,
          coverMs: post.coverMs,
          audio,
          aiGenerated: post.aiGenerated,
        });
      } catch (error) {
        const failure = deps.classify(error);
        // Never silently remove the chosen sound. A refusal can be caused by
        // authentication or permissions, so do not diagnose every one as bad audio.
        if (audio && !failure.transient) {
          return fail(
            {
              message: `Instagram could not create the post: ${failure.message} Nothing was posted. The selected sound ${scheduledPostAudioName(post)} was kept.`,
              transient: false,
            },
            false,
          );
        }
        return fail(failure, false);
      }
      // Fetching and processing the video takes a while; look again on a later tick.
      return (await write({ containerId, containerAt: now, nextCheckAt: new Date(now.getTime() + containerRecheckDelayMs(0)) })) ? "waiting" : "lost";
    }

    const { status, detail } = await deps.containerStatus(post.containerId, ready.token);
    if (status === "IN_PROGRESS") {
      const elapsed = now.getTime() - (post.containerAt ?? post.updatedAt).getTime();
      if (elapsed > SCHEDULED_POST_CONTAINER_TIMEOUT_MS) {
        return fail({ message: "Instagram was still processing the video after 30 minutes.", transient: true }, false);
      }
      return (await write({ nextCheckAt: new Date(now.getTime() + containerRecheckDelayMs(elapsed)) })) ? "waiting" : "lost";
    }
    if (status === "PUBLISHED") {
      // Published by an earlier try whose answer was lost; the media id is not known.
      return (await write({ status: "PUBLISHED", publishedAt: now, error: null, nextCheckAt: null })) ? "published" : "lost";
    }
    if (status === "ERROR" || status === "EXPIRED") {
      // A new container is made on the retry.
      return fail({ message: detail ? `Instagram could not process the video: ${detail}` : `Instagram reported ${status} for the video.`, transient: true }, false);
    }

    const { mediaId, permalink } = await deps.publish(ready.igUserId, post.containerId, ready.token);
    return (await write({ status: "PUBLISHED", mediaId, permalink, publishedAt: now, error: null, nextCheckAt: null })) ? "published" : "lost";
  } catch (error) {
    // Any container is kept: after a failed publish call the next check finds
    // it PUBLISHED if the call went through after all, so nothing posts twice.
    return fail(deps.classify(error), true);
  }
}

export type TickResult = { claimed: number } & Record<StepOutcome, number>;

/** One publisher tick: claim what is due, then advance each claimed post in turn. */
export async function runScheduledPosts(
  prisma: PrismaClient,
  deps: ScheduledPostDeps,
  options: { now?: () => Date; limit?: number } = {},
): Promise<TickResult> {
  const clock = options.now ?? (() => new Date());
  const claims = await claimDueScheduledPosts(prisma, { now: clock(), limit: options.limit });
  const result: TickResult = { claimed: claims.length, published: 0, waiting: 0, retrying: 0, failed: 0, lost: 0 };
  for (const claim of claims) {
    try {
      result[await advanceScheduledPost(prisma, claim, deps, clock())] += 1;
    } catch (error) {
      // A database error: the claim lapses after 15 minutes and the post is tried again.
      console.error(`scheduled posts: ${claim.id} could not be advanced`, error);
    }
  }
  return result;
}

/**
 * Cancels a post that has not started publishing, and with a reel the story
 * still waiting to follow it (one already claimed sees the cancelled reel on
 * its next check and ends the same way). False if it has started (or is not
 * the workspace's).
 */
export async function cancelScheduledPost(prisma: PrismaClient, input: { id: string; workspaceId: string }): Promise<boolean> {
  const { count } = await prisma.scheduledPost.updateMany({
    where: { id: input.id, workspaceId: input.workspaceId, status: "SCHEDULED" },
    data: { status: "CANCELLED", nextCheckAt: null },
  });
  if (count !== 1) return false;
  await prisma.scheduledPost.updateMany({
    where: { afterPostId: input.id, workspaceId: input.workspaceId, status: "SCHEDULED" },
    data: { status: "CANCELLED", nextCheckAt: null },
  });
  return true;
}

/**
 * Changes or removes the sound of a post that has not started publishing.
 * False if it has (its container may already carry the old sound), or it is
 * not the workspace's.
 */
export async function setScheduledPostAudio(
  prisma: PrismaClient,
  input: {
    id: string;
    workspaceId: string;
    audio: { audioId: string; title: string; artist: string | null; audioVolume: number; videoVolume: number } | null;
  },
): Promise<boolean> {
  const audio = input.audio;
  const { count } = await prisma.scheduledPost.updateMany({
    where: { id: input.id, workspaceId: input.workspaceId, status: "SCHEDULED" },
    data: audio
      ? { audioId: audio.audioId, audioTitle: audio.title, audioArtist: audio.artist, audioVolume: audio.audioVolume, videoVolume: audio.videoVolume }
      : { audioId: null, audioTitle: null, audioArtist: null, audioVolume: null, videoVolume: null },
  });
  return count === 1;
}
