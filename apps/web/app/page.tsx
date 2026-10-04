import Link from "next/link";
import { prisma } from "@reelwalk/db";
import { BrandMark } from "@/components/icons";
import { NewReelPicker } from "@/components/new-reel-picker";
import { StatusBadge } from "@/components/status-badge";
import { TabBar } from "@/components/tab-bar";
import { formatDuration } from "@/lib/format";
import { coverUrls, durationOf, readTimeline } from "@/lib/reels";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ReelsPage() {
  const user = await getCurrentUser();
  const reels = await prisma.reel.findMany({
    where: { workspaceId: user.workspaceId },
    orderBy: { updatedAt: "desc" },
    take: 60,
    include: { renderJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } } },
  });
  const timelines = reels.map((reel) => readTimeline(reel.timeline));
  const covers = await coverUrls(timelines);

  return (
    <>
      <main className="shell">
        <header className="shell-head">
          <span className="brand">
            <BrandMark />
            ReelWalk
          </span>
          <span className="muted small">{user.workspace.name}</span>
        </header>
        <h1 style={{ marginBottom: 16 }}>Reels</h1>

        <ul className="reel-grid">
          <li>
            <NewReelPicker />
          </li>
          {reels.map((reel, index) => {
            const duration = durationOf(timelines[index]);
            const lastExport = reel.renderJobs[0];
            return (
              <li key={reel.id}>
                {/* No prefetch: each editor page is a heavy render (media library, signed
                    URLs). Prefetching every card filled the browser's six connections to
                    the host, and a tap on New reel then waited behind them. */}
                <Link href={`/reels/${reel.id}`} className="reel-card" data-testid="reel-card" prefetch={false}>
                  <span className="reel-thumb">
                    {covers[index] ? (
                      <img src={covers[index]!} alt="" />
                    ) : (
                      <span className="empty-frame">No media yet</span>
                    )}
                    {duration > 0 ? <span className="chip timecode">{formatDuration(duration)}</span> : null}
                  </span>
                  <span className="reel-card-title">{reel.title}</span>
                  {lastExport ? <StatusBadge status={lastExport.status} /> : <span className="muted small">Draft</span>}
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
