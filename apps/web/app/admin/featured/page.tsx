import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@reelwalk/db";
import { LocalTime } from "@/components/local-time";
import { TabBar } from "@/components/tab-bar";
import { isAdmin } from "@/lib/admin";
import { outputUrls } from "@/lib/render-jobs";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Featured reels · ReelWalk" };

/** Reels whose owners said we may repost them, newest consent first, with the file to download. Admins only (User.isAdmin). */
export default async function FeaturedAdminPage() {
  const user = await getCurrentUser();
  if (!isAdmin(user)) notFound();

  const reels = await prisma.reel.findMany({
    where: { featureConsent: true },
    orderBy: { featureConsentAt: "desc" },
    take: 200,
    include: {
      workspace: { select: { name: true } },
      renderJobs: { where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, take: 1, include: { output: true } },
    },
  });
  const rows = await Promise.all(
    reels.map(async (reel) => ({ reel, job: reel.renderJobs[0] ?? null, urls: reel.renderJobs[0] ? await outputUrls(reel.renderJobs[0]) : null })),
  );

  return (
    <>
      <main className="shell">
        <h1 style={{ marginBottom: 4 }}>Featured reels</h1>
        <p className="muted small" style={{ marginBottom: 20 }}>
          {rows.length} reel{rows.length === 1 ? "" : "s"} we may repost. Credit the handle in the caption; check the box is still ticked on the
          day you post.
        </p>
        {rows.length === 0 ? (
          <div className="empty">
            <strong>Nobody has offered a reel yet.</strong>
          </div>
        ) : (
          rows.map(({ reel, job, urls }) => (
            <section key={reel.id} className="card" data-testid="featured-row">
              <h2>{reel.title}</h2>
              <p className="muted small">
                {reel.workspace.name} · credit {reel.featureHandle ? <strong>@{reel.featureHandle}</strong> : <em>no handle given</em>}
                {reel.featureConsentAt ? (
                  <>
                    {" "}
                    · consented <LocalTime date={reel.featureConsentAt} />
                  </>
                ) : null}
              </p>
              {reel.caption ? <p className="caption-box small">{reel.caption}</p> : null}
              <div className="export-actions">
                {urls && job ? (
                  <a className="btn btn-quiet" href={urls.downloadUrl} download>
                    Download MP4
                  </a>
                ) : (
                  <span className="muted small">No finished export</span>
                )}
                {reel.shareToken ? (
                  <Link className="btn btn-quiet" href={`/r/${reel.shareToken}`} prefetch={false}>
                    Share page
                  </Link>
                ) : (
                  <span />
                )}
              </div>
            </section>
          ))
        )}
      </main>
      <TabBar />
    </>
  );
}
