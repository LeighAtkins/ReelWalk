import { pollAnswer } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { cancelRunOfStep } from "@/lib/workflows";

export const dynamic = "force-dynamic";

/**
 * Where a background AI request is: its persisted state, nothing more. A
 * durable step (ADR 0049) is settled only by the worker, including when its
 * lease goes stale; polling never fails a job by its age.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ status: "FAILED", error: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const step = await prisma.workflowStep.findFirst({ where: { id, run: { workspaceId: user.workspaceId } }, select: { status: true, result: true, error: true } });
  if (step) return Response.json(pollAnswer(step), { headers: { "Cache-Control": "private, no-store" } });
  // In-process jobs from before AI_JOBS_DURABLE (lib/ai-jobs.ts).
  const job = await prisma.aiJob.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { kind: true, status: true, result: true, error: true, createdAt: true } });
  if (!job) return Response.json({ status: "FAILED", error: "That request was not found." }, { status: 404 });
  if (job.status === "DONE") return Response.json({ status: "DONE", result: job.result });
  if (job.status === "RUNNING" && Date.now() - job.createdAt.getTime() > 5 * 60_000) {
    // An in-process job whose server went away (a deploy) never finishes. Say so, without recording a failure
    // that may not be true: the work may still complete and its saved result stays readable.
    const error = job.kind === "director"
      ? "The review result is not available yet. No new paid request was submitted. Resume this saved review later rather than starting another."
      : "That took too long and was stopped. Try again.";
    return Response.json({ status: "RUNNING", possiblyStale: true, error });
  }
  return Response.json({ status: job.status, error: job.error });
}

/** Stop a durable request. Persisted: a step not yet sent to the AI service never starts; one already sent finishes and is kept. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  if (!(await cancelRunOfStep(user.workspaceId, id))) return Response.json({ ok: false, message: "That request was not found." }, { status: 404 });
  return Response.json({ ok: true });
}
