import { aiOffResponse } from "@/lib/ai-gate";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { advanceRun, endRun, findDirectorRun, noteRun, publicRun } from "@/lib/workflows";

export const runtime = "nodejs";

const action = z.discriminatedUnion("action", [
  // The sheet applied a review and started its shot: one round, the shot's credits.
  z.object({ action: z.literal("advance"), stepId: z.string().min(1), index: z.number().int().min(0).max(5), generationId: z.string().min(1).max(64), applied: z.boolean() }),
  // The sheet applied a review (the next review must start from it) or has news to show: position only.
  z.object({ action: z.literal("note"), message: z.string().max(500).optional(), appliedStepId: z.string().min(1).optional() }),
  // The run ended: "succeeded" when the loop decided it was done, "failed" when something stopped it.
  z.object({ action: z.literal("finish"), message: z.string().max(500), outcome: z.enum(["succeeded", "failed"]).default("succeeded") }),
  z.object({ action: z.literal("stop"), message: z.string().max(500).optional() }),
]);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "Sign in to view this run." }, { status: 401 });
  const { id, runId } = await params;
  const run = await findDirectorRun(user.workspaceId, id, runId);
  if (!run) return Response.json({ ok: false, message: "Run not found." }, { status: 404 });
  return Response.json({ ok: true, run: publicRun(run) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "Sign in to direct this reel." }, { status: 401 });
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ ok: false, message: "Invalid request origin." }, { status: 403 });
  const parsed = action.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, message: "Could not read the request." }, { status: 400 });
  const { id, runId } = await params;
  const base = { workspaceId: user.workspaceId, reelId: id, runId };
  const data = parsed.data;
  if (data.action === "advance") {
    const result = await advanceRun({ ...base, stepId: data.stepId, index: data.index, generationId: data.generationId, applied: data.applied });
    return result.ok ? Response.json({ ok: true, run: result.run }) : Response.json({ ok: false, message: result.message }, { status: result.status });
  }
  if (data.action === "note") {
    const run = await noteRun({ ...base, patch: data.message ? { message: data.message } : {}, applied: data.appliedStepId ? { stepId: data.appliedStepId } : undefined });
    return run ? Response.json({ ok: true, run }) : Response.json({ ok: false, message: "Run not found." }, { status: 404 });
  }
  const ended = await endRun({ ...base, outcome: data.action === "stop" ? "stopped" : data.outcome, message: data.message ?? "Stopped." });
  if (!ended) return Response.json({ ok: false, message: "Run not found." }, { status: 404 });
  // Not applied: the run was stopped, already ended, or another tab is still reviewing. The current run says which.
  return ended.applied ? Response.json({ ok: true, run: ended.run }) : Response.json({ ok: false, message: "This run has moved on in another tab.", run: ended.run }, { status: 409 });
}
