import Link from "next/link";
import { notFound } from "next/navigation";
import { isActive } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { AutoRefresh } from "@/components/auto-refresh";
import { ArrowLeftIcon, FilmIcon } from "@/components/icons";
import { JobCard } from "@/components/job-card";
import { RenderForm } from "@/components/render-form";
import { UploadMedia } from "@/components/upload-media";
import { outputUrls } from "@/lib/render-jobs";
import { mediaUrl } from "@/lib/storage";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const property = await prisma.property.findFirst({
    where: { id, workspaceId: user.workspaceId },
    include: {
      media: { orderBy: { createdAt: "desc" } },
      renderJobs: { orderBy: { createdAt: "desc" }, include: { output: true, template: true, mediaAsset: true } },
    },
  });
  if (!property) notFound();

  const [templates, thumbnails, jobs] = await Promise.all([
    prisma.template.findMany({ orderBy: { name: "asc" } }),
    Promise.all(property.media.map((asset) => (asset.kind === "IMAGE" ? mediaUrl(asset.objectKey) : null))),
    Promise.all(property.renderJobs.map(async (job) => ({ job, urls: await outputUrls(job) }))),
  ]);

  return (
    <>
      <AutoRefresh active={property.renderJobs.some((job) => isActive(job.status))} />

      <header className="page-head">
        <Link href="/" className="back-link">
          <ArrowLeftIcon />
          All properties
        </Link>
        <h1>{property.title}</h1>
        <p className="muted">{property.address ?? "No address"}</p>
        {property.description ? <p>{property.description}</p> : null}
      </header>

      <div className="columns">
        <div className="stack">
          <section className="section">
            <div className="section-head">
              <h2>Media</h2>
            </div>
            <UploadMedia propertyId={property.id} />
            {property.media.length === 0 ? null : (
              <ul className="media-grid" data-testid="media-list">
                {property.media.map((asset, index) => (
                  <li key={asset.id}>
                    {thumbnails[index] ? (
                      <div className="frame">
                        <img src={thumbnails[index]} alt="" loading="lazy" />
                      </div>
                    ) : (
                      <div className="frame frame-video">
                        <span className="frame-note">
                          <FilmIcon />
                          Video
                        </span>
                      </div>
                    )}
                    <span className="media-name" title={asset.fileName}>
                      {asset.fileName}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Render a reel</h2>
            </div>
            <RenderForm
              propertyId={property.id}
              media={property.media.map((asset) => ({ id: asset.id, label: asset.fileName }))}
              templates={templates.map((template) => ({
                id: template.id,
                name: template.name,
                description: template.description,
                defaultCaption: template.defaultCaption,
              }))}
            />
          </section>
        </div>

        <section className="section">
          <div className="section-head">
            <h2>Reels</h2>
          </div>
          {jobs.length === 0 ? (
            <p className="empty">
              <strong>No reels yet.</strong>
              Upload media, pick a template and render. Each reel shows up here while it renders.
            </p>
          ) : (
            <ul className="jobs" data-testid="job-list">
              {jobs.map(({ job, urls }) => (
                <li key={job.id}>
                  <JobCard job={job} urls={urls} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
