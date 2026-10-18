import { prisma } from "@reelwalk/db";

/**
 * Long AI requests in the background (ADR 0021). A whole-reel cut takes
 * over a minute: longer than Cloudflare waits for an answer (100 s), close
 * to App Runner's limit, and long enough for a phone to drop the connection.
 * So the route starts the work, answers at once with the job's id, and the
 * browser asks /api/ai-jobs/<id> every couple of seconds until it is done.
 * Those check-ins also keep the instance's CPU awake while it works.
 */
export async function startAiJob(input: { workspaceId: string; reelId?: string; kind: "ask" | "autopilot" | "video-suggestion" | "listing" }, work: () => Promise<unknown>): Promise<string> {
  const job = await prisma.aiJob.create({ data: { workspaceId: input.workspaceId, reelId: input.reelId, kind: input.kind }, select: { id: true } });
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
