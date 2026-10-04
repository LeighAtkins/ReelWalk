import Link from "next/link";
import { prisma } from "@reelwalk/db";
import { CreatePropertyForm } from "@/components/create-property-form";
import { StatusBadge } from "@/components/status-badge";
import { countOf } from "@/lib/format";
import { mediaUrl } from "@/lib/storage";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function PropertiesPage() {
  const user = await getCurrentUser();
  const properties = await prisma.property.findMany({
    where: { workspaceId: user.workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { media: true, renderJobs: true } },
      renderJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
      media: { where: { kind: "IMAGE" }, orderBy: { createdAt: "desc" }, take: 1, select: { objectKey: true } },
    },
  });
  const covers = await Promise.all(properties.map((property) => (property.media[0] ? mediaUrl(property.media[0].objectKey) : null)));

  return (
    <>
      <header className="page-head">
        <h1>Properties</h1>
        <p>
          {user.workspace.name} has {countOf(properties.length, "listing")}. Open one to add photos or a walkthrough video and render a
          vertical reel.
        </p>
      </header>

      <div className="columns columns-aside">
        <section>
          {properties.length === 0 ? (
            <p className="empty">
              <strong>No properties yet.</strong>
              Create the first one with the form on this page.
            </p>
          ) : (
            <ul className="tiles">
              {properties.map((property, index) => (
                <li key={property.id} className="tile">
                  <div className={covers[index] ? "frame" : "frame frame-plan"}>
                    {covers[index] ? <img src={covers[index]} alt="" loading="lazy" /> : null}
                    {property.renderJobs[0] ? <StatusBadge status={property.renderJobs[0].status} /> : null}
                  </div>
                  {/* No prefetch: each property page signs fresh media URLs, so prefetching
                      every tile would render the whole list's pages on each visit. */}
                  <Link href={`/properties/${property.id}`} className="tile-title condensed" prefetch={false}>
                    {property.title}
                  </Link>
                  <div className="muted small">{property.address ?? "No address"}</div>
                  <div className="muted small">
                    {property._count.media} media, {countOf(property._count.renderJobs, "render")}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="sheet">
          <h2>New property</h2>
          <CreatePropertyForm />
        </aside>
      </div>
    </>
  );
}
