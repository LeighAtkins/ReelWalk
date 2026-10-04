import type { RenderJobStatus } from "@reelwalk/core";
import { retryRenderJob } from "@/app/actions";
import { formatDateTime } from "@/lib/format";
import type { OutputUrls } from "@/lib/render-jobs";
import { DownloadIcon } from "./icons";
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

/** The 9:16 slot the reel will occupy, showing whatever the job has to show so far. */
function JobFrame({ job, urls }: JobCardProps) {
  if (urls) {
    return (
      <div className="frame">
        <video src={urls.playUrl} controls playsInline preload="metadata" data-testid="job-video" />
      </div>
    );
  }
  if (job.status === "RUNNING") {
    return (
      <div
        className="frame frame-running"
        role="progressbar"
        aria-label="Render progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.progress}
      >
        <span className="frame-fill" style={{ height: `${job.progress}%` }} />
        <span className="frame-figure condensed">{job.progress}%</span>
      </div>
    );
  }
  if (job.status === "QUEUED") {
    return (
      <div className="frame frame-queued">
        <span className="frame-note">Waiting to start</span>
      </div>
    );
  }
  return (
    <div className="frame frame-failed">
      <span className="frame-note">{job.status === "FAILED" ? "No reel" : "Reel file missing"}</span>
    </div>
  );
}

export function JobCard({ job, urls }: JobCardProps) {
  return (
    <article className="job" data-testid="job-card" data-job-id={job.id}>
      <JobFrame job={job} urls={urls} />

      <div className="job-body">
        <div className="job-head">
          <h3>{job.template?.name ?? "Timeline editor"}</h3>
          <StatusBadge status={job.status} />
        </div>

        {job.caption ? <p className="job-caption">“{job.caption}”</p> : null}

        <p className="muted small">
          {job.mediaAsset ? `From ${job.mediaAsset.fileName}, ` : ""}
          {formatDateTime(job.createdAt)}
          {job.attempt > 1 ? `, attempt ${job.attempt}` : ""}
        </p>

        {job.error ? (
          <p className="error small" title={job.error}>
            {job.error}
          </p>
        ) : null}

        {job.status === "FAILED" ? (
          <form action={retryRenderJob}>
            <input type="hidden" name="jobId" value={job.id} />
            <button className="button button-quiet" type="submit">
              Retry render
            </button>
          </form>
        ) : null}

        {urls ? (
          <a className="button button-quiet" href={urls.downloadUrl}>
            <DownloadIcon />
            Download MP4
          </a>
        ) : null}
      </div>
    </article>
  );
}
