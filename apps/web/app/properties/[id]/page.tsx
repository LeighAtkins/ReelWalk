import { notFound } from "next/navigation";
import { isActive } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { AutoRefresh } from "@/components/auto-refresh";
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
    <div className="columns">
      <AutoRefresh active={property.renderJobs.some((job) => isActive(job.status))} />

      <section className="stack">
        <div className="card">
          <h1>{property.title}</h1>
          <p className="muted">{property.address ?? "No address"}</p>
          {property.description ? <p>{property.description}</p> : null}
        </div>

        <div className="card">
          <h2>Media</h2>
          <UploadMedia propertyId={property.id} />
          {property.media.length === 0 ? (
            <p className="muted">Nothing uploaded yet.</p>
          ) : (
            <ul className="mediaGrid" data-testid="media-list">
              {property.media.map((asset, index) => (
                <li key={asset.id}>
                  {thumbnails[index] ? (
                    <img src={thumbnails[index]} alt={asset.fileName} />
                  ) : (
                    <div className="videoTile">VIDEO</div>
                  )}
                  <span className="small">{asset.fileName}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Render a reel</h2>
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
        </div>
      </section>

      <section>
        <h2>Render history</h2>
        {jobs.length === 0 ? (
          <p className="muted">No renders yet.</p>
        ) : (
          <ul className="list" data-testid="job-list">
            {jobs.map(({ job, urls }) => (
              <li key={job.id}>
                <JobCard job={job} urls={urls} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
