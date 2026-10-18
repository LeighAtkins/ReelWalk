import { z } from "zod";
import { aiClipCredits, directorPlanSchema } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { directorGenerationRequestId } from "@/lib/director-request";
import { createAiGeneration } from "@/lib/ai-video";
import { ensureWorkerRunning } from "@/lib/render-capacity";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to approve a generation." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const body = z.object({ editId: z.string().min(1).max(64), index: z.number().int().min(0).max(2), quotedCredits: z.number().int().positive(), approved: z.literal(true) }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Approve a specific Opus proposal." }, { status: 400 });
  const { id } = await params;
  const record = await prisma.aiEdit.findFirst({ where: { id: body.data.editId, reelId: id, workspaceId: user.workspaceId }, select: { plan: true, model: true } });
  const stored = record?.plan as { kind?: string; plan?: unknown } | undefined;
  const plan = directorPlanSchema.safeParse(stored?.plan);
  if (!record || !/^claude-opus-/.test(record.model) || stored?.kind !== "director" || !plan.success || !plan.data.shots[body.data.index]) return Response.json({ error: "That Opus proposal is not available." }, { status: 404 });
  const proposal = plan.data.shots[body.data.index];
  if (body.data.quotedCredits !== aiClipCredits(proposal.durationSeconds)) return Response.json({ error: "The credit quote changed. Reload the proposal before approving." }, { status: 409 });
  try {
    // Browser cannot replace the approved prompt, frame IDs, duration, or request identity.
    const job = await createAiGeneration(user, {
      requestId: directorGenerationRequestId(body.data.editId, body.data.index),
      prompt: proposal.prompt, durationSeconds: proposal.durationSeconds,
      shot: { mode: "custom", ...(proposal.first ? { first: proposal.first } : {}), ...(proposal.last ? { last: proposal.last } : {}) },
    }, { exactPrompt: true });
    await ensureWorkerRunning();
    return Response.json({ id: job.id }, { status: 202 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not start this shot." }, { status: 409 }); }
}
