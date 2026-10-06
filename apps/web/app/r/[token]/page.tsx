import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@reelwalk/db";
import { CopyButton } from "@/components/copy-button";
import { BrandMark, DownloadIcon } from "@/components/icons";
import { outputUrls } from "@/lib/render-jobs";
import { appUrl } from "@/lib/app-url";

export const dynamic = "force-dynamic";

/**
 * The public page behind a share link. No sign-in: anyone with the link can
 * watch the latest export, read the caption and download the file. The owner
 * turns the link off from the export screen.
 */

async function loadShared(token: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
  const reel = await prisma.reel.findUnique({
    where: { shareToken: token },
    include: {
      workspace: { select: { name: true } },
      renderJobs: { where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, take: 1, include: { output: true } },
    },
  });
  if (!reel) return null;
  const job = reel.renderJobs[0] ?? null;
  const urls = job ? await outputUrls(job) : null;
  return { reel, job, urls };
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const shared = await loadShared(token);
  if (!shared) return { title: "ReelWalk" };
  const base = await appUrl();
  return {
    title: `${shared.reel.title} · ${shared.reel.workspace.name}`,
    description: shared.reel.caption.split("\n")[0] || "A reel made with ReelWalk",
    openGraph: {
      type: "video.other",
      title: shared.reel.title,
      description: shared.reel.caption.split("\n")[0] || undefined,
      url: `${base}/r/${token}`,
      videos: shared.urls ? [{ url: shared.urls.playUrl, type: "video/mp4", width: 1080, height: 1920 }] : undefined,
    },
    robots: { index: false },
  };
}

export default async function SharedReelPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shared = await loadShared(token);
  if (!shared) notFound();
  const { reel, urls } = shared;

  return (
    <main className="share">
      <header className="share-head">
        <span className="brand">
          <BrandMark />
          ReelWalk
        </span>
        <span className="muted small">{reel.workspace.name}</span>
      </header>

      <section className="export" data-testid="shared-reel">
        <div className="export-frame">
          {urls ? (
            <video src={urls.playUrl} controls playsInline autoPlay muted loop data-testid="shared-video" />
          ) : (
            <span className="export-figure" role="status">
              <strong>Not exported yet</strong>
              <span className="small">Check back once the video has finished rendering.</span>
            </span>
          )}
        </div>
        <div>
          <h1>{reel.title}</h1>
          {reel.caption ? (
            <p className="caption-box" style={{ marginTop: 10 }} data-testid="shared-caption">
              {reel.caption}
            </p>
          ) : null}
        </div>
        {urls ? (
          <div className="export-actions">
            <a className="btn btn-signal" href={urls.downloadUrl} download>
              <DownloadIcon size={18} />
              Save video
            </a>
            {reel.caption ? <CopyButton text={reel.caption} label="Copy caption" copied="Caption copied" /> : null}
            <a className="btn btn-quiet" href="https://www.instagram.com/" target="_blank" rel="noopener">
              Open Instagram
            </a>
            <p className="muted small" style={{ gridColumn: "1 / -1" }}>
              Save the video, paste the caption, post it as a Reel.
            </p>
          </div>
        ) : null}
      </section>
    </main>
  );
}
