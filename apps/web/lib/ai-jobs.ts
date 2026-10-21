import { prisma } from "@reelwalk/db";

/**
 * Long AI requests in the background (ADR 0021). A whole-reel cut takes
 * over a minute: longer than Cloudflare waits for an answer (100 s), close
 * to App Runner's limit, and long enough for a phone to drop the connection.
 * So the route starts the work, answers at once with the job's id, and the
 * browser asks /api/ai-jobs/<id> every couple of seconds until it is done.
 * Those check-ins also keep the instance's CPU awake while it works.
 */
export async function startAiJob(input: { workspaceId: string; reelId: string; kind: "ask" | "autopilot"; requestId?: string }, work: () => Promise<unknown>): Promise<string> {
  // A retried start (same request id from the browser) resumes the job instead of running the work twice.
  const id = input.requestId ? `${input.kind}-${input.requestId}` : undefined;
  if (id) {
    const existing = await prisma.aiJob.findFirst({ where: { id, workspaceId: input.workspaceId }, select: { id: true } });
    if (existing) return existing.id;
  }
  let job: { id: string };
  try {
    job = await prisma.aiJob.create({ data: { ...(id ? { id } : {}), workspaceId: input.workspaceId, reelId: input.reelId, kind: input.kind }, select: { id: true } });
  } catch (error) {
    const raced = id ? await prisma.aiJob.findFirst({ where: { id, workspaceId: input.workspaceId }, select: { id: true } }) : null;
    if (raced) return raced.id;
    throw error;
  }
  void (async () => {
    try {
      const result = await work();
      await prisma.aiJob.update({ where: { id: job.id }, data: { status: "DONE", result: JSON.parse(JSON.stringify(result)) } });
    } catch (error) {
      console.error(`ai job ${job.id} failed`, error);
      await prisma.aiJob.update({ where: { id: job.id }, data: { status: "FAILED", error: error instanceof Error ? error.message : String(error) } }).catch(() => undefined);
    }
  })();
  return job.id;
}
