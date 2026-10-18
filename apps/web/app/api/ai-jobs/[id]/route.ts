import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Where a background AI request is (lib/ai-jobs.ts): still running, or its answer. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ status: "FAILED", error: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const job = await prisma.aiJob.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { kind: true, status: true, result: true, error: true, createdAt: true } });
  if (!job) return Response.json({ status: "FAILED", error: "That request was not found." }, { status: 404 });
  // A job whose server went away mid-way (a deploy) never finishes; after five minutes, say so.
  if (job.status === "RUNNING" && Date.now() - job.createdAt.getTime() > 5 * 60_000) {
    if (job.kind === "director") return Response.json({ status: "FAILED", error: "The review result is not available yet. No new paid request was submitted. Resume this saved review later rather than starting another." });
    return Response.json({ status: "FAILED", error: "That took too long and was stopped. Try again." });
  }
  return Response.json(job.status === "DONE" ? { status: "DONE", result: job.result } : { status: job.status, error: job.error });
}
