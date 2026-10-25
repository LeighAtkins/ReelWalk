import { aiOffResponse } from "@/lib/ai-gate";
import { parseTimeline, referencedAssetIds } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { startAiJob } from "@/lib/ai-jobs";
import { runAiStep } from "@/lib/ai-steps";
import { durableAiJobs, startSingleStepRun } from "@/lib/workflows";
import { getSessionUser } from "@/lib/auth";
import { mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * The editor's "Ask for a change" (ADR 0020). The editor sends the timeline
 * it is showing, which may be newer than the saved one, and gets the changed
 * timeline back to apply as one undoable step; its autosave then saves it.
 * Nothing is written to the reel here, so an open editor never conflicts
 * with itself. A plain route for the same reason as /save: action ids change
 * with every deploy.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }

  let body: { request?: unknown; timeline?: unknown; answers?: unknown; requestId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, message: "Could not read the request." }, { status: 400 });
  }
  if (typeof body.request !== "string") return Response.json({ ok: false, message: "Say what you would like changed." }, { status: 400 });

  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true, timeline: true } });
  if (!reel) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });

  let timeline;
  try {
    timeline = parseTimeline(body.timeline ?? reel.timeline);
  } catch {
    return Response.json({ ok: false, message: "The reel's edit could not be read." }, { status: 400 });
  }
  // The editor's copy may only use media this studio can see.
  const ids = referencedAssetIds(timeline);
  const allowed = await prisma.mediaAsset.count({ where: { id: { in: ids }, ...mediaScope(user.workspaceId) } });
  if (allowed !== ids.length) return Response.json({ ok: false, message: "The reel uses media that is not in your library." }, { status: 400 });

  const answers = Array.isArray(body.answers)
    ? body.answers
        .filter((entry): entry is { question: string; answer: string } => typeof entry?.question === "string" && typeof entry?.answer === "string")
        .slice(0, 3)
    : [];
  const payload = { request: body.request, timeline, answers };
  const requestId = requestIdOf(body.requestId);
  // Durable path (ADR 0049): the worker runs it under a lease, so a web restart loses nothing.
  if (durableAiJobs()) {
    const started = await startSingleStepRun({ user, reelId: reel.id, kind: "ask", stepKind: "ask", requestId, payload, baseline: timeline });
    return started.ok ? Response.json({ ok: true, jobId: started.jobId }) : Response.json({ ok: false, message: started.message }, { status: started.status });
  }
  // A whole-reel brief can take over a minute: run it in the background and let the browser check back.
  const jobId = await startAiJob({ workspaceId: user.workspaceId, reelId: reel.id, kind: "ask", requestId }, () => runAiStep({ kind: "ask", user, reelId: reel.id, payload }));
  return Response.json({ ok: true, jobId });
}

/** The browser's id for this request when it sends one (a retried POST then resumes); otherwise a fresh one. */
function requestIdOf(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : crypto.randomUUID();
}
