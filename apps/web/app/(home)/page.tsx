import Link from "next/link";
import { prisma } from "@reelwalk/db";
import { pickAttribution } from "@/lib/attribution";
import { BrandMark } from "@/components/icons";
import { Landing } from "@/components/landing/landing";
import { LinkPending } from "@/components/link-pending";
import { NewReelPicker } from "@/components/new-reel-picker";
import { StatusBadge } from "@/components/status-badge";
import { TabBar } from "@/components/tab-bar";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { formatAgo, formatDuration } from "@/lib/format";
import { getSessionUser } from "@/lib/auth";
import { coverUrls, durationOf, readTimeline } from "@/lib/reels";
import { sampleReels } from "@/lib/sample-reels";
import { getCurrentUser, mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * The front door. Signed out it is the marketing page; signed in, the studio's
 * reels. The proxy lets / through without a session cookie for this reason.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ welcome?: string } & Record<string, string | string[] | undefined>> }) {
  if (!(await getSessionUser())) return <Landing samples={sampleReels()} attribution={pickAttribution(await searchParams)} />;
  return <ReelsHome searchParams={searchParams} />;
}

async function ReelsHome({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { welcome } = await searchParams;
  const user = await getCurrentUser();
  const reels = await prisma.reel.findMany({
    where: { workspaceId: user.workspaceId },
    orderBy: { updatedAt: "desc" },
    take: 60,
    include: { renderJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } } },
  });
  const [librarySize, songs] = await Promise.all([
    prisma.mediaAsset.count({ where: { ...mediaScope(user.workspaceId), kind: { not: "AUDIO" } } }),
    // Instagram sounds' private copies (ADR 0019) are not songs in your library.
    prisma.mediaAsset.count({ where: { ...mediaScope(user.workspaceId), kind: "AUDIO", instagramAudioId: null } }),
  ]);
  const tours = await prisma.tour.findMany({
    where: { workspaceId: user.workspaceId },
    select: { id: true, name: true, _count: { select: { media: true } } },
    take: 3,
  });
  const timelines = reels.map((reel) => readTimeline(reel.timeline));
  const covers = await coverUrls(timelines);
  const now = new Date();

  return (
    <>
      <main className="shell shell-home">
        <header className="shell-head">
          <span className="brand">
            <BrandMark />
            ReelWalk
          </span>
          <WorkspaceSwitcher />
        </header>
        <h1 className="home-title">Reels</h1>
        {welcome === "1" ? (
          <p className="welcome" role="status" data-testid="welcome">
            <strong>Welcome to {user.workspace.name}.</strong> Tap <strong>New reel</strong> and pick photos and videos from your
            phone.
            {librarySize > 0 || songs > 0
              ? ` To practise first, your library already has ${[
                  librarySize > 0 ? `${librarySize} photos and clips` : null,
                  songs > 0 ? `${songs} songs` : null,
                ]
                  .filter(Boolean)
                  .join(" and ")}.`
              : null}
          </p>
        ) : null}

        <NewReelPicker librarySize={librarySize} tours={tours.map((tour) => ({ id: tour.id, name: tour.name, rooms: tour._count.media }))} />

        {reels.length === 0 ? (
          <p className="home-empty">Reels you make show up here. Each one saves as you edit, so you can stop and come back.</p>
        ) : (
          <h2 className="home-section">Your reels</h2>
        )}
        <ul className="reel-grid">
          {reels.map((reel, index) => {
            const duration = durationOf(timelines[index]);
            const lastExport = reel.renderJobs[0];
            return (
              <li key={reel.id}>
                {/* No prefetch: each editor page is a heavy render (media library, signed
                    URLs). Prefetching every card filled the browser's six connections to
                    the host, and a tap on New reel then waited behind them. LinkPending
                    answers the tap until the editor's loading frame arrives. */}
                <Link href={`/reels/${reel.id}`} className="reel-card" data-testid="reel-card" prefetch={false}>
                  <span className="reel-thumb">
                    {covers[index] ? (
                      <img src={covers[index]!} alt="" loading={index < 4 ? "eager" : "lazy"} />
                    ) : (
                      <span className="empty-frame">No media yet</span>
                    )}
                    {lastExport ? <StatusBadge status={lastExport.status} /> : null}
                    {duration > 0 ? <span className="chip timecode reel-duration">{formatDuration(duration)}</span> : null}
                    <LinkPending />
                    <span className="reel-meta">
                      <span className="reel-card-title">{reel.title}</span>
                      <span className="reel-card-when">
                        {lastExport ? "" : "Draft, "}edited {formatAgo(reel.updatedAt, now)}
                      </span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </main>
      <TabBar />
    </>
  );
}
