import Link from "next/link";
import { isActive } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { retryRenderJob } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatusBadge } from "@/components/status-badge";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function RendersPage() {
  const user = await getCurrentUser();
  const jobs = await prisma.renderJob.findMany({
    where: { workspaceId: user.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { property: { select: { id: true, title: true } }, template: { select: { name: true } } },
  });
  const counts = await prisma.renderJob.groupBy({ by: ["status"], where: { workspaceId: user.workspaceId }, _count: true });
  const countFor = (status: string) => counts.find((row) => row.status === status)?._count ?? 0;

  return (
    <div className="stack">
      <AutoRefresh active={jobs.some((job) => isActive(job.status))} />
      <h1>Renders</h1>
      <div className="stats">
        {(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const).map((status) => (
          <div key={status} className="card stat">
            <StatusBadge status={status} />
            <strong>{countFor(status)}</strong>
          </div>
        ))}
      </div>

      <div className="card">
        {jobs.length === 0 ? (
          <p className="muted">No renders yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Template</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Attempt</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    {job.property ? (
                      <Link href={`/properties/${job.property.id}`} prefetch={false}>
                        {job.property.title}
                      </Link>
                    ) : (
                      "Timeline editor"
                    )}
                  </td>
                  <td>{job.template?.name ?? "—"}</td>
                  <td>
                    <StatusBadge status={job.status} />
                    {job.error ? <div className="error small">{job.error}</div> : null}
                  </td>
                  <td>{job.progress}%</td>
                  <td>{job.attempt}</td>
                  <td className="small">{job.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td>
                    {job.status === "FAILED" ? (
                      <form action={retryRenderJob}>
                        <input type="hidden" name="jobId" value={job.id} />
                        <button className="button secondary" type="submit">
                          Retry
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
