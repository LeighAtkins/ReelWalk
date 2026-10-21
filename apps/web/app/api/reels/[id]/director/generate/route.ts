import { z } from "zod";
import { CHAINED_REFERENCE_MESSAGE, aiClipCredits, directorPlanSchema, isGeneratedAssetId, type AiShot } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { directorGenerationRequestId } from "@/lib/director-request";
import { createAiGeneration } from "@/lib/ai-video";
import { ensureWorkerRunning } from "@/lib/render-capacity";

export const runtime = "nodejs";

/** Credits the run's reviews have already spent: every generation one of them could have started, unless it failed and refunded. */
async function runSpend(workspaceId: string, reelId: string, runId: string): Promise<number> {
  const reviews = await prisma.aiEdit.findMany({ where: { workspaceId, reelId, OR: [{ id: runId }, { plan: { path: ["runId"], equals: runId } }] }, select: { id: true } });
  const requestIds = reviews.flatMap(review => [0, 1, 2].map(index => directorGenerationRequestId(review.id, index)));
  const generations = await prisma.aiGeneration.findMany({ where: { workspaceId, requestId: { in: requestIds }, status: { not: "FAILED" } }, select: { credits: true } });
  return generations.reduce((total, generation) => total + generation.credits, 0);
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to approve a generation." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const body = z.object({
    editId: z.string().min(1).max(64), index: z.number().int().min(0).max(2), quotedCredits: z.number().int().positive(), approved: z.literal(true),
    // "Make it for me" (ADR 0037): the studio approved a budget for the run, not this shot; the server checks the run has room.
    auto: z.object({ runId: z.string().min(1).max(64), budgetCredits: z.number().int().min(1).max(40) }).optional(),
    // Who she is in composed stills (ADR 0056): the picked kit, else the workspace default. A generated take only when asked for by name.
    presenterId: z.string().min(1).max(64).optional(),
    allowGeneratedReference: z.literal(true).optional(),
  }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Approve a specific Opus proposal." }, { status: 400 });
  const { id } = await params;
  const record = await prisma.aiEdit.findFirst({ where: { id: body.data.editId, reelId: id, workspaceId: user.workspaceId }, select: { plan: true, model: true } });
  const stored = record?.plan as { kind?: string; plan?: unknown; runId?: string } | undefined;
  const plan = directorPlanSchema.safeParse(stored?.plan);
  if (!record || !/^claude-opus-/.test(record.model) || stored?.kind !== "director" || !plan.success || !plan.data.shots[body.data.index]) return Response.json({ error: "That Opus proposal is not available." }, { status: 404 });
  const proposal = plan.data.shots[body.data.index];
  if (body.data.quotedCredits !== aiClipCredits(proposal.durationSeconds, Boolean(proposal.voice))) return Response.json({ error: "The credit quote changed. Reload the proposal before approving." }, { status: 409 });
  if (body.data.auto) {
    const { runId, budgetCredits } = body.data.auto;
    if (body.data.editId !== runId && stored.runId !== runId) return Response.json({ error: "That proposal is not part of this run." }, { status: 409 });
    const spent = await runSpend(user.workspaceId, id, runId);
    if (spent + body.data.quotedCredits > budgetCredits) return Response.json({ error: `This run has used ${spent} of its ${budgetCredits} credits; the next shot needs ${body.data.quotedCredits}.` }, { status: 409 });
  }
  let compose: NonNullable<AiShot["compose"]> | undefined;
  if (proposal.compose) {
    const { first, last, framing } = proposal.compose;
    const described = { ...(first ? { first } : {}), ...(last ? { last } : {}), framing };
    // The kit is preferred over whatever frame Opus named: a generated take as the face reference is how faces drifted.
    const kitId = body.data.presenterId ?? (await prisma.presenter.findFirst({ where: { workspaceId: user.workspaceId, isDefault: true }, select: { id: true } }))?.id;
    if (kitId) compose = { presenterId: kitId, ...described };
    else if (!proposal.compose.presenter) return Response.json({ error: "Set up a presenter in Ask Opus before making this shot." }, { status: 409 });
    else if (isGeneratedAssetId(proposal.compose.presenter.assetId) && !body.data.allowGeneratedReference) return Response.json({ error: CHAINED_REFERENCE_MESSAGE }, { status: 409 });
    else compose = { presenter: proposal.compose.presenter, ...(body.data.allowGeneratedReference ? { allowGeneratedReference: true } : {}), ...described };
  }
  try {
    // Browser cannot replace the approved prompt, frame IDs, duration, or request identity.
    const job = await createAiGeneration(user, {
      requestId: directorGenerationRequestId(body.data.editId, body.data.index),
      prompt: proposal.prompt, durationSeconds: proposal.durationSeconds,
      shot: {
        mode: "custom", ...(proposal.first ? { first: proposal.first } : {}), ...(proposal.last ? { last: proposal.last } : {}),
        ...(proposal.line && proposal.voice ? { line: proposal.line, voice: proposal.voice } : {}),
        ...(compose ? { compose } : {}),
      },
    }, { exactPrompt: true });
    await ensureWorkerRunning();
    return Response.json({ id: job.id }, { status: 202 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not start this shot." }, { status: 409 }); }
}
