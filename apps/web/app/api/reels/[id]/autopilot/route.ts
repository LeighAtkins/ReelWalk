import { aiOffResponse } from "@/lib/ai-gate";
import { CUT_FEELS, LISTING_KINDS, parseTimeline, referencedAssetIds, type CutBrief, type ListingInfo } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { newAssets } from "@/lib/ai-edit";
import { startAiJob } from "@/lib/ai-jobs";
import { runAiStep } from "@/lib/ai-steps";
import { quickDraft } from "@/lib/autopilot";
import { durableAiJobs, startSingleStepRun } from "@/lib/workflows";
import { mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";
// The model can take most of a minute on a whole reel.
export const maxDuration = 120;

const FIELDS = ["address", "price", "beds", "baths", "area", "openHouse", "contact"] as const;

/**
 * "Make it for me" (ADR 0021). The editor sends the shots it is showing, a
 * style and the facts typed; it gets the finished timeline back, applies it
 * as one step and starts the export itself.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }

  let body: { timeline?: unknown; style?: unknown; info?: Record<string, unknown>; quick?: unknown; requestId?: unknown; feel?: unknown; listing?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, message: "Could not read the request." }, { status: 400 });
  }
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true, timeline: true } });
  if (!reel) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });

  let timeline;
  try {
    timeline = parseTimeline(body.timeline ?? reel.timeline);
  } catch {
    return Response.json({ ok: false, message: "The reel could not be read." }, { status: 400 });
  }
  const ids = referencedAssetIds(timeline);
  const allowed = await prisma.mediaAsset.count({ where: { id: { in: ids }, ...mediaScope(user.workspaceId) } });
  if (allowed !== ids.length) return Response.json({ ok: false, message: "The reel uses media that is not in your library." }, { status: 400 });

  const info: ListingInfo = {};
  for (const field of FIELDS) {
    const value = body.info?.[field];
    if (typeof value === "string" && value.trim()) info[field] = value.trim().slice(0, 80);
  }
  const styleId = typeof body.style === "string" ? body.style : "just-listed";
  // The first cut, by rule, straight away (ADR 0024); the model's cut is asked for separately.
  if (body.quick === true) {
    // The answers to "what is this?" and "feel" (ADR 0087), when the person gave them; else the style decides.
    const brief: Partial<CutBrief> = {
      ...((CUT_FEELS as readonly unknown[]).includes(body.feel) ? { feel: body.feel as CutBrief["feel"] } : {}),
      ...((LISTING_KINDS as readonly unknown[]).includes(body.listing) ? { listing: body.listing as CutBrief["listing"] } : {}),
    };
    const result = await quickDraft({ user, timeline, styleId, info, brief });
    return Response.json(result.ok ? { ...result, assets: await newAssets(user.workspaceId, timeline, result.timeline) } : result);
  }
  const payload = { timeline, styleId, info: info as Record<string, string> };
  const requestId = typeof body.requestId === "string" && /^[0-9a-f-]{36}$/i.test(body.requestId) ? body.requestId : crypto.randomUUID();
  // Durable path (ADR 0049): the worker runs it under a lease, so a web restart loses nothing.
  if (durableAiJobs()) {
    const started = await startSingleStepRun({ user, reelId: reel.id, kind: "autopilot", stepKind: "autopilot", requestId, payload, baseline: timeline });
    return started.ok ? Response.json({ ok: true, jobId: started.jobId }) : Response.json({ ok: false, message: started.message }, { status: started.status });
  }
  // Over a minute of work: run it in the background and let the browser check back (lib/ai-jobs.ts).
  const jobId = await startAiJob({ workspaceId: user.workspaceId, reelId: reel.id, kind: "autopilot", requestId }, () => runAiStep({ kind: "autopilot", user, reelId: reel.id, payload }));
  return Response.json({ ok: true, jobId });
}
