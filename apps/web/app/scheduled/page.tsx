import type { Metadata } from "next";
import Link from "next/link";
import { insightsLine, instagramAudioLabel } from "@reelwalk/core";
import { prisma, type ScheduledPostStatus } from "@reelwalk/db";
import { cancelScheduled } from "@/app/scheduled-actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { BackIcon, MusicIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { ScheduledSound } from "@/components/scheduled-sound";
import { ScheduledStory } from "@/components/scheduled-story";
import { SubmitButton } from "@/components/submit-button";
import { TabBar } from "@/components/tab-bar";
import { postInsights, type PostInsights } from "@/lib/instagram-messaging";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Scheduled posts · ReelWalk" };

const LABELS: Record<ScheduledPostStatus, string> = {
  SCHEDULED: "Scheduled",
  PUBLISHING: "Posting",
  PUBLISHED: "Posted",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

type Row = Awaited<ReturnType<typeof loadPosts>>[number];

function loadPosts(workspaceId: string, upcoming: boolean) {
  return prisma.scheduledPost.findMany({
    where: { workspaceId, status: upcoming ? { in: ["SCHEDULED", "PUBLISHING"] } : { in: ["PUBLISHED", "FAILED", "CANCELLED"] } },
    orderBy: { publishAt: upcoming ? "asc" : "desc" },
    take: upcoming ? 120 : 30,
    include: {
      // A story cut has no reel of its own; its export (sourceJob) does (ADR 0065).
      renderJob: { select: { caption: true, reel: { select: { id: true, title: true } }, sourceJob: { select: { reel: { select: { id: true, title: true } } } } } },
      stories: { where: { status: { in: ["SCHEDULED", "PUBLISHING"] } }, select: { id: true } },
    },
  });
}

/** The studio's queue of Instagram posts: what is coming, and what happened to the rest. */
export default async function ScheduledPage({ searchParams }: { searchParams: Promise<{ cancelled?: string }> }) {
  const { cancelled } = await searchParams;
  const user = await getCurrentUser();
  const [upcoming, past, account] = await Promise.all([
    loadPosts(user.workspaceId, true),
    loadPosts(user.workspaceId, false),
    prisma.socialAccount.findUnique({
      where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } },
      select: { username: true, messagingToken: true },
    }),
  ]);
  // Live numbers for posted reels (ADR 0027), read with the Instagram Login connection.
  const token = account?.messagingToken;
  const insights = new Map<string, PostInsights | "permission" | null>(
    token
      ? await Promise.all(
          past
            .filter((post) => post.kind === "REEL" && post.status === "PUBLISHED" && post.mediaId)
            .map(async (post) => [post.id, await postInsights(token, post.mediaId!)] as const),
        )
      : [],
  );
  const needsReconnect = [...insights.values()].includes("permission");

  return (
    <>
      <main className="shell">
        <AutoRefresh active={upcoming.some((post) => post.status === "PUBLISHING")} intervalMs={10_000} />
        <header className="shell-head">
          <Link href="/account" className="btn btn-quiet" prefetch={false}>
            <BackIcon size={18} />
            Account
          </Link>
        </header>
        <h1 style={{ marginBottom: 4 }}>Scheduled posts</h1>
        <p className="muted small" style={{ marginBottom: 16 }}>
          {account ? `Reels and stories queued to post to @${account.username}. ` : "Connect Instagram on the Account tab to schedule posts. "}
          Schedule one from an export&apos;s screen; times are shown in your time zone. A story goes out right after its reel, never before.
        </p>
        {cancelled === "1" ? (
          <p className="toast" role="status">
            Cancelled. Nothing will be posted.
          </p>
        ) : null}
        {cancelled === "late" ? (
          <p className="error small" role="alert">
            That post had already started going out, so it could not be cancelled.
          </p>
        ) : null}

        <section className="scheduled-section" aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading">Coming up</h2>
          {upcoming.length === 0 ? (
            <div className="empty">
              <strong>Nothing scheduled.</strong>
              <span className="muted small">Open a finished export and tap Schedule to post it later.</span>
            </div>
          ) : (
            <ul className="export-list" data-testid="scheduled-upcoming">
              {upcoming.map((post) => (
                <PostRow key={post.id} post={post} />
              ))}
            </ul>
          )}
        </section>

        {past.length > 0 ? (
          <section className="scheduled-section" aria-labelledby="past-heading">
            <h2 id="past-heading">Earlier</h2>
            {needsReconnect || (account && !token && past.some((post) => post.status === "PUBLISHED")) ? (
              <p className="muted small" data-testid="insights-reconnect">
                To see views and watch time here, <Link href="/account#replies">reconnect Instagram on the Account tab</Link>.
              </p>
            ) : null}
            <ul className="export-list" data-testid="scheduled-past">
              {past.map((post) => (
                <PostRow key={post.id} post={post} insights={insights.get(post.id)} />
              ))}
            </ul>
          </section>
        ) : null}
      </main>
      <TabBar />
    </>
  );
}

function PostRow({ post, insights }: { post: Row; insights?: PostInsights | "permission" | null }) {
  const reel = post.renderJob.reel ?? post.renderJob.sourceJob?.reel ?? null;
  const story = post.kind === "STORY";
  return (
    <li className="export-row scheduled-row" data-testid="scheduled-row" data-status={post.status} data-id={post.id} data-kind={post.kind}>
      <span className="export-row-body">
        {reel ? (
          <Link href={`/reels/${reel.id}/export`} prefetch={false}>
            {story ? `Story · ${reel.title}` : reel.title}
          </Link>
        ) : (
          <span>{story ? "Story · earlier export" : "Earlier export"}</span>
        )}
        {story ? (
          <span className="muted small" data-testid="scheduled-kind">
            {post.afterPostId ? "Goes out right after the reel" : "A story on its own"}
            {post.status === "PUBLISHING" && !post.containerId ? ", waiting for it" : ""}
          </span>
        ) : null}
        <span className="muted small">
          <LocalTime date={post.publishedAt ?? post.publishAt} />
          {post.status === "PUBLISHING" && post.attempts > 0 ? `, retry ${post.attempts}` : ""}
        </span>
        <span className={`badge badge-${post.status.toLowerCase()}`} data-testid="scheduled-status">
          {LABELS[post.status]}
        </span>
        {post.caption ? (
          <span className="small muted" title={post.caption} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {post.caption}
          </span>
        ) : null}
        {post.status === "SCHEDULED" && !story ? <ScheduledStory postId={post.id} initial={post.stories.length > 0} /> : null}
        {post.status === "SCHEDULED" && !story ? (
          <ScheduledSound
            postId={post.id}
            initial={
              post.audioId
                ? { audioId: post.audioId, title: post.audioTitle ?? post.audioId, artist: post.audioArtist, audioVolume: post.audioVolume ?? 100, videoVolume: post.videoVolume ?? 0 }
                : null
            }
          />
        ) : post.audioId && !story ? (
          <span className="small muted sound-label" data-testid="scheduled-sound-label">
            <MusicIcon size={14} />
            {instagramAudioLabel({ title: post.audioTitle ?? post.audioId, artist: post.audioArtist })}
          </span>
        ) : null}
        {insights && insights !== "permission" ? (
          <span className="small" data-testid="scheduled-insights">
            {insightsLine(insights)}
          </span>
        ) : null}
        {post.status === "PUBLISHED" && post.permalink ? (
          <a className="link small" href={post.permalink} target="_blank" rel="noopener" data-testid="scheduled-permalink">
            Open on Instagram
          </a>
        ) : null}
        {post.status === "FAILED" && post.error ? (
          <span className="small error" data-testid="scheduled-error">
            {post.error}
          </span>
        ) : null}
      </span>
      {post.status === "SCHEDULED" ? (
        <form action={cancelScheduled}>
          <input type="hidden" name="id" value={post.id} />
          <SubmitButton className="btn btn-quiet" pendingLabel="Cancelling…" testId="scheduled-cancel">
            Cancel
          </SubmitButton>
        </form>
      ) : (
        <span />
      )}
    </li>
  );
}
