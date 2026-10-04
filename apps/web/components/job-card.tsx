import type { RenderJobStatus } from "@reelwalk/core";
import { retryRenderJob } from "@/app/actions";
import type { OutputUrls } from "@/lib/render-jobs";
import { StatusBadge } from "./status-badge";

type JobCardProps = {
  job: {
    id: string;
    status: RenderJobStatus;
    progress: number;
    attempt: number;
    caption: string | null;
    error: string | null;
    createdAt: Date;
    template: { name: string } | null;
    mediaAsset: { fileName: string } | null;
  };
  urls: OutputUrls | null;
};

export function JobCard({ job, urls }: JobCardProps) {
  return (
    <article className="card job" data-testid="job-card" data-job-id={job.id}>
      <div className="row">
        <div>
          <div className="title">{job.template?.name ?? "Timeline editor"}</div>
          <div className="muted small">
            {job.mediaAsset?.fileName ?? "—"} · {job.createdAt.toISOString().slice(0, 16).replace("T", " ")}
            {job.attempt > 1 ? ` · attempt ${job.attempt}` : ""}
          </div>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {job.status === "RUNNING" || job.status === "QUEUED" ? (
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
          <span style={{ width: `${job.progress}%` }} />
        </div>
      ) : null}

      {job.error ? <p className="error small">{job.error}</p> : null}

      {job.status === "FAILED" ? (
        <form action={retryRenderJob}>
          <input type="hidden" name="jobId" value={job.id} />
          <button className="button secondary" type="submit">
            Retry render
          </button>
        </form>
      ) : null}

      {urls ? (
        <div className="result">
          <div className="phone">
            <video src={urls.playUrl} controls playsInline preload="metadata" data-testid="job-video" />
          </div>
          <a className="button secondary" href={urls.downloadUrl}>
            Download MP4
          </a>
        </div>
      ) : null}
    </article>
  );
}
