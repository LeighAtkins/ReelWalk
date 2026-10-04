import { prisma } from "@reelwalk/db";
import { outputUrls } from "@/lib/render-jobs";
import { getCurrentUser } from "@/lib/workspace";

// Status names the editor already understands.
const LEGACY_STATUS = { QUEUED: "queued", RUNNING: "running", SUCCEEDED: "done", FAILED: "failed" } as const;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await getCurrentUser();
  const job = await prisma.renderJob.findFirst({ where: { id: jobId, workspaceId: user.workspaceId }, include: { output: true } });
  if (!job) return Response.json({ detail: "Render job not found" }, { status: 404 });

  const urls = await outputUrls(job);
  return Response.json({
    job_id: job.id,
    status: LEGACY_STATUS[job.status],
    progress: job.progress,
    output_url: urls?.playUrl ?? null,
    error: job.error,
  });
}
