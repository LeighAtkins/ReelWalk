import Link from "next/link";
import { prisma } from "@reelwalk/db";
import { CreatePropertyForm } from "@/components/create-property-form";
import { StatusBadge } from "@/components/status-badge";
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
    },
  });

  return (
    <div className="columns">
      <section className="card">
        <h1>New property</h1>
        <p className="muted">Create a listing, then add photos or a walkthrough video and render a reel.</p>
        <CreatePropertyForm />
      </section>

      <section>
        <h2>
          Properties <span className="muted">· {user.workspace.name}</span>
        </h2>
        {properties.length === 0 ? (
          <p className="muted">No properties yet.</p>
        ) : (
          <ul className="list">
            {properties.map((property) => (
              <li key={property.id} className="card row">
                <div>
                  <Link href={`/properties/${property.id}`} className="title">
                    {property.title}
                  </Link>
                  <div className="muted small">
                    {property.address ?? "No address"} · {property._count.media} media · {property._count.renderJobs} renders
                  </div>
                </div>
                {property.renderJobs[0] ? <StatusBadge status={property.renderJobs[0].status} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
