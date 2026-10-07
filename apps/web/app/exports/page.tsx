import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { exportProgressText, isActive } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { retryRenderJob } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatusBadge } from "@/components/status-badge";
import { TabBar } from "@/components/tab-bar";
import { coverUrls, readTimeline } from "@/lib/reels";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ExportsPage() {
  const user = await getCurrentUser();
  const jobs = await prisma.renderJob.findMany({
    where: { workspaceId: user.workspaceId, kind: { not: "PREVIEW" } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { reel: { select: { id: true, title: true, timeline: true } } },
  });
  const now = new Date();
  const covers = await coverUrls(jobs.map((job) => readTimeline(job.reel?.timeline)));

  return (
    <>
      <main className="shell">
        <AutoRefresh active={jobs.some((job) => isActive(job.status))} />
        <h1 style={{ marginBottom: 16 }}>Exports</h1>
        {jobs.length === 0 ? (
          <div className="empty">
            <strong>No exports yet.</strong>
            <span className="muted small">Open a reel and tap Export to make a video for Instagram.</span>
          </div>
        ) : (
          <ul className="export-list">
            {jobs.map((job, index) => (
              <li key={job.id} className="export-row" data-testid="export-row">
                <span className="mini-frame">
                  {covers[index] ? <img src={covers[index]!} alt="" /> : null}
                </span>
                <span className="export-row-body">
                  {job.reel ? (
                    <Link href={`/reels/${job.reel.id}/export`} prefetch={false}>
                      {job.reel.title}
                    </Link>
                  ) : (
                    <span>{job.caption ?? "Earlier render"}</span>
                  )}
                  <span className="muted small">
                    <LocalTime date={job.createdAt} />
                    {job.status === "RUNNING" ? `, ${job.progress}%` : ""}
                    {job.attempt > 1 ? `, attempt ${job.attempt}` : ""}
                  </span>
                  <StatusBadge status={job.status} />
                  {isActive(job.status) ? (
                    <span className="small muted">{[exportProgressText(job, now).phase, exportProgressText(job, now).detail].filter(Boolean).join(" · ")}</span>
                  ) : null}
                  {job.status === "FAILED" && job.error ? (
                    <span className="small muted" title={job.error}>
                      {friendlyError(job.error)}
                    </span>
                  ) : null}
                </span>
                {job.status === "FAILED" ? (
                  <form action={retryRenderJob}>
                    <input type="hidden" name="jobId" value={job.id} />
                    <button className="btn btn-quiet" type="submit">
                      Retry
                    </button>
                  </form>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
      <TabBar />
    </>
  );
}

/** Worker errors in words a person can act on; the raw message stays in the tooltip. */
function friendlyError(error: string): string {
  if (/SIGKILL|out of memory|OOM/i.test(error)) return "The render machine ran out of memory. Retry; long reels of 4K video can need a second try.";
  if (/deleted/i.test(error)) return error;
  if (/timed? ?out/i.test(error)) return "The render took too long and was stopped. Retry, or shorten the reel.";
  return error.length > 140 ? `${error.slice(0, 140)}…` : error;
}
