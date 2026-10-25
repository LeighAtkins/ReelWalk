import { getSessionUser } from "@/lib/auth";
import { aiVideoConfigured, createAiGeneration, generationInput, getAiBalance } from "@/lib/ai-video";
import { ensureWorkerRunning } from "@/lib/render-capacity";
import { toLibraryAssets } from "@/lib/library";
import { prisma } from "@reelwalk/db";
import { AI_DRAFT_NO_END_FRAME, CHAINED_REFERENCE_MESSAGE, queuePosition, type PresenterFraming } from "@reelwalk/core";

export const runtime = "nodejs";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to use AI video." }, { status: 401 });
  const now = new Date();
  const [balance, jobs, queue] = await Promise.all([
    getAiBalance(user.workspaceId),
    prisma.aiGeneration.findMany({ where: { workspaceId: user.workspaceId }, orderBy: { createdAt: "desc" }, take: 20 }),
    // The take queue (ADR 0069): every waiting or composing take and the hour's Veo submissions, for each take's place in line.
    prisma.aiGeneration.findMany({ where: { workspaceId: user.workspaceId, OR: [{ status: { in: ["QUEUED", "SUBMITTING"] } }, { submitStartedAt: { gt: new Date(now.getTime() - 3600_000) } }] },
      select: { id: true, status: true, createdAt: true, submitStartedAt: true, leaseUntil: true } }),
  ]);
  const assets = await prisma.mediaAsset.findMany({ where: { workspaceId: user.workspaceId, id: { in: jobs.flatMap(j => j.assetId ? [j.assetId] : []) } } });
  const library = new Map((await toLibraryAssets(assets)).map(a => [a.id, a]));
  const drafts = await prisma.reel.findMany({ where: { workspaceId: user.workspaceId, id: { in: jobs.map(j => `ai-promo-${j.id}`) } }, select: { id: true } });
  const draftIds = new Set(drafts.map(d => d.id));
  // A draft that already has a final (not a failed one) is not offered "Make it final" again (ADR 0076).
  const finals = new Map(jobs.flatMap(j => {
    const of = (j.shot as { finalOf?: unknown } | null)?.finalOf;
    return typeof of === "string" && j.status !== "FAILED" ? [[of, j.id] as const] : [];
  }));
  if (jobs.some(j => ["QUEUED", "SUBMITTING", "RUNNING"].includes(j.status))) await ensureWorkerRunning();
  return Response.json({ enabled: aiVideoConfigured(), balance, jobs: jobs.map(j => {
    const asset = j.assetId ? library.get(j.assetId) ?? null : null;
    const gate = gateSummary(j.identityChecks);
    return {
      id: j.id, prompt: j.prompt, status: j.status, error: j.error, shot: j.shot,
      referenceDepth: j.referenceDepth, identityScore: j.identityScore, failureCode: j.failureCode,
      // The identity gate's measured face and the framing it was composed at (ADR 0069), from the accepted still.
      faceHeightPx: gate.faceHeightPx, framing: gate.framing,
      queue: j.status === "QUEUED" ? queuePosition(queue, j.id, now) : null,
      // The auto-trim of a voiced take and whether it said its line (ADR 0069).
      take: asset?.transcript?.take ?? null,
      draftId: draftIds.has(`ai-promo-${j.id}`) ? `ai-promo-${j.id}` : null,
      credits: j.credits, durationSeconds: j.durationSeconds, finalId: finals.get(j.id) ?? null,
      createdAt: j.createdAt.toISOString(), asset,
    };
  }) }, { headers: { "Cache-Control": "private, no-store" } });
}

/** The measured face and framing of the last check on the start frame (the one Veo was given), from the stored gate record. */
function gateSummary(checks: unknown): { faceHeightPx: number | null; framing: PresenterFraming | null } {
  const list = Array.isArray(checks) ? checks as { end?: string; faceHeightPx?: number | null; framing?: PresenterFraming }[] : [];
  const last = [...list].reverse().find(check => check.end === "first") ?? list[list.length - 1];
  return { faceHeightPx: last?.faceHeightPx ?? null, framing: last?.framing ?? null };
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to use AI video." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const input = generationInput.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    // A chained reference has its own answer (ADR 0056); everything else is the usual description error.
    const chained = input.error.issues.some(issue => issue.message === CHAINED_REFERENCE_MESSAGE);
    const draftEnd = input.error.issues.some(issue => issue.message === AI_DRAFT_NO_END_FRAME);
    const badMove = input.error.issues.some(issue => issue.path[0] === "move");
    return Response.json({ error: chained ? CHAINED_REFERENCE_MESSAGE : draftEnd ? AI_DRAFT_NO_END_FRAME : badMove ? "That is not one of the camera moves. GET /api/moves lists them." : "Describe your shot in 10–2,000 characters." }, { status: 400 });
  }
  try {
    const job = await createAiGeneration(user, input.data);
    await ensureWorkerRunning();
    return Response.json({ id: job.id }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not start generation." }, { status: 409 });
  }
}
