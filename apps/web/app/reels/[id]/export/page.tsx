import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isActive } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { retryRenderJob } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { CaptionEditor } from "@/components/caption-editor";
import { BackIcon, DownloadIcon } from "@/components/icons";
import { ShareButton } from "@/components/share-button";
import { ShareLink } from "@/components/share-link";
import { PostToInstagram } from "@/components/post-to-instagram";
import { appUrl } from "@/lib/app-url";
import { outputUrls } from "@/lib/render-jobs";
import { coverUrls, readTimeline } from "@/lib/reels";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ExportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({
    where: { id, workspaceId: user.workspaceId },
    include: { renderJobs: { orderBy: { createdAt: "desc" }, take: 1, include: { output: true } } },
  });
  if (!reel) notFound();
  const job = reel.renderJobs[0];
  if (!job) redirect(`/reels/${reel.id}`);

  const [urls, [cover], base, instagram] = await Promise.all([
    outputUrls(job),
    coverUrls([readTimeline(reel.timeline)]),
    appUrl(),
    prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } }, select: { username: true } }),
  ]);
  const active = isActive(job.status);

  return (
    <main className="shell">
      <AutoRefresh active={active} />
      <header className="shell-head">
        <Link href={`/reels/${reel.id}`} className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Edit
        </Link>
        <span className="muted small">{reel.title}</span>
      </header>

      <section className="export" data-testid="export" data-status={job.status}>
        <div className="export-frame">
          {urls ? (
            <video src={urls.playUrl} controls playsInline autoPlay muted loop data-testid="export-video" />
          ) : (
            <>
              {cover ? <img src={cover} alt="" style={{ opacity: 0.35 }} /> : null}
              {active ? <span className="export-fill" style={{ height: `${job.progress}%` }} /> : null}
              <span className="export-figure" role="status">
                {active ? (
                  <>
                    <strong className="timecode">{job.progress}%</strong>
                    <span>{job.status === "QUEUED" ? "Waiting for a render slot" : "Rendering 1080×1920"}</span>
                  </>
                ) : (
                  <>
                    <strong>Failed</strong>
                    <span className="small">{job.error ?? "The render did not finish."}</span>
                  </>
                )}
              </span>
            </>
          )}
        </div>

        {urls ? (
          <>
            <div>
              <h1>Ready for Instagram</h1>
              <p className="muted" style={{ marginTop: 6 }}>
                1080×1920 MP4, 30 fps. Share it to Instagram from your phone, download it, or send a link anyone can open.
              </p>
            </div>
            <div className="export-actions">
              {instagram ? <PostToInstagram jobId={job.id} username={instagram.username} /> : null}
              <ShareButton url={urls.playUrl} fileName={`${reel.title}.mp4`} caption={reel.caption} />
              <a className="btn btn-quiet" href={urls.downloadUrl} download>
                <DownloadIcon size={18} />
                Download
              </a>
              <ShareLink reelId={reel.id} initialUrl={reel.shareToken ? `${base}/r/${reel.shareToken}` : null} />
              <Link className="btn btn-quiet" href={`/reels/${reel.id}`} prefetch={false}>
                Keep editing
              </Link>
            </div>
          </>
        ) : job.status === "FAILED" ? (
          <form action={retryRenderJob} className="export-actions">
            <input type="hidden" name="jobId" value={job.id} />
            <button className="btn btn-signal" type="submit">
              Retry export
            </button>
          </form>
        ) : (
          <p className="muted small" style={{ textAlign: "center" }}>
            You can leave this screen. The export keeps going and appears under Exports.
          </p>
        )}

        <CaptionEditor reelId={reel.id} initial={reel.caption} />
      </section>
    </main>
  );
}
