import Link from "next/link";
import { isActive } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { retryRenderJob } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
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
    <>
      <AutoRefresh active={jobs.some((job) => isActive(job.status))} />

      <header className="page-head">
        <h1>Renders</h1>
        <p>Every reel requested in {user.workspace.name}, newest first. This page updates by itself while anything is rendering.</p>
        <ul className="tally">
          {(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const).map((status) => (
            <li key={status}>
              {countFor(status)}
              <StatusBadge status={status} />
            </li>
          ))}
        </ul>
      </header>

      <section className="section">
        {jobs.length === 0 ? (
          <p className="empty">
            <strong>No renders yet.</strong>
            Open a property and render a reel to see it here.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Template</th>
                  <th>Status</th>
                  <th className="num">Progress</th>
                  <th className="num">Attempt</th>
                  <th>Requested</th>
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
                    <td>{job.template?.name ?? "None"}</td>
                    <td>
                      <StatusBadge status={job.status} />
                      {job.error ? (
                        <div className="error small" title={job.error}>
                          {job.error}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{job.progress}%</td>
                    <td className="num">{job.attempt}</td>
                    <td className="num small">{formatDateTime(job.createdAt)}</td>
                    <td>
                      {job.status === "FAILED" ? (
                        <form action={retryRenderJob}>
                          <input type="hidden" name="jobId" value={job.id} />
                          <button className="button button-quiet" type="submit">
                            Retry render
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
