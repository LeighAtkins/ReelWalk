import type { RenderJobStatus } from "@reelwalk/core";

const LABELS: Record<RenderJobStatus, string> = {
  QUEUED: "Queued",
  RUNNING: "Rendering",
  SUCCEEDED: "Done",
  FAILED: "Failed",
};

export function StatusBadge({ status }: { status: RenderJobStatus }) {
  return (
    <span className={`badge badge-${status.toLowerCase()}`} data-testid="job-status" data-status={status}>
      {LABELS[status]}
    </span>
  );
}
