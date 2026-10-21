import { createHash } from "node:crypto";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { directorInput, directReel } from "@/lib/ai-director";
import { newAssets } from "@/lib/ai-edit";
import { parseTimeline } from "@reelwalk/core";
import { aiModel, aiProvider } from "@/lib/openai";
import { activeDirectorRun, addDirectorReview, durableAiJobs, startSingleStepRun } from "@/lib/workflows";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to view direction." }, { status: 401 });
  const { id } = await params;
  const records = await prisma.aiEdit.findMany({ where: { workspaceId: user.workspaceId, reelId: id, plan: { path: ["kind"], equals: "director" } }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, model: true, createdAt: true, plan: true, applied: true, skipped: true } });
  const legacy = await prisma.aiJob.findMany({ where: { workspaceId: user.workspaceId, reelId: id, kind: "director", status: "RUNNING" }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true } });
  // Durable reviews (ADR 0049) still queued or running, and the "make it for me" run in progress, if any.
  const steps = await prisma.workflowStep.findMany({ where: { kind: "director-review", status: { in: ["QUEUED", "RUNNING"] }, run: { workspaceId: user.workspaceId, reelId: id } }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true } });
  const pending = [...steps, ...legacy];
  const run = await activeDirectorRun(user.workspaceId, id);
  const reviews = await Promise.all(records.map(async record => {
    const stored = record.plan as unknown as { plan: unknown; baseline: unknown; timeline: unknown };
    return { ...stored, ok: true, editId: record.id, model: record.model, applied: record.applied, skipped: record.skipped, assets: await newAssets(user.workspaceId, parseTimeline(stored.baseline), parseTimeline(stored.timeline)) };
  }));
  return Response.json({ records: reviews, pending, run, durable: durableAiJobs() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "Sign in to direct this reel." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ ok: false, message: "Invalid request origin." }, { status: 403 });
  if (aiProvider() !== "anthropic" || !/^claude-opus-/.test(aiModel())) return Response.json({ ok: false, message: "Connect Claude Opus to use the director." }, { status: 409 });
  // Bound streaming bodies even when Content-Length is missing.
  const reader = request.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  if (!reader) return Response.json({ ok: false, message: "Missing review." }, { status: 400 });
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 8_000_000) { await reader.cancel(); return Response.json({ ok: false, message: "Choose fewer review frames." }, { status: 413 }); } chunks.push(part.value); }
  let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return Response.json({ ok: false, message: "Could not read review." }, { status: 400 }); }
  const parsed = directorInput.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, message: "Describe the reel and choose valid review frames." }, { status: 400 });
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true } });
  if (!reel) return Response.json({ ok: false, message: "Reel not found." }, { status: 404 });
  if (durableAiJobs()) {
    // The worker runs the review under a lease (ADR 0049); a round of a "make it for me" run joins that run.
    const runId = (body as { workflowRunId?: unknown }).workflowRunId;
    const started = typeof runId === "string" && runId
      ? await addDirectorReview({ user, reelId: id, runId, requestId: parsed.data.requestId, payload: parsed.data, baseline: parsed.data.timeline })
      : await startSingleStepRun({ user, reelId: id, kind: "director", stepKind: "director-review", requestId: parsed.data.requestId, payload: parsed.data, baseline: parsed.data.timeline });
    return started.ok ? Response.json({ ok: true, jobId: started.jobId }, { status: started.resumed ? 200 : 202 }) : Response.json({ ok: false, message: started.message, reason: started.reason }, { status: started.status });
  }
  const jobId = `director-${parsed.data.requestId}`, requestHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
  const existing = await prisma.aiJob.findUnique({ where: { id: jobId }, select: { workspaceId: true, reelId: true, kind: true, result: true } });
  if (existing) {
    if (existing.workspaceId !== user.workspaceId || existing.reelId !== id || existing.kind !== "director" || (existing.result as { requestHash?: string } | null)?.requestHash !== requestHash) return Response.json({ ok: false, message: "Review identity changed." }, { status: 409 });
    return Response.json({ ok: true, jobId });
  }
  try { await prisma.aiJob.create({ data: { id: jobId, workspaceId: user.workspaceId, reelId: id, kind: "director", result: { requestHash } } }); }
  catch { return Response.json({ ok: false, message: "That review is already starting. Resume it from history." }, { status: 409 }); }
  void (async () => {
    try {
      const result = await directReel(user, reel, parsed.data);
      await prisma.aiJob.update({ where: { id: jobId }, data: { status: "DONE", result: { ...result, requestHash } as never } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      console.error("Opus director failed", reason);
      const message = reason === "Could not reach Claude." ? "Opus took too long to answer. Try again; nothing was changed." : `Opus could not finish: ${reason.slice(0, 200)}`;
      await prisma.aiJob.update({ where: { id: jobId }, data: { status: "FAILED", error: message } }).catch(() => undefined);
    }
  })();
  return Response.json({ ok: true, jobId }, { status: 202 });
}
