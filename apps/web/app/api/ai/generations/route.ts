import { getSessionUser } from "@/lib/auth";
import { aiVideoConfigured, createAiGeneration, generationInput, getAiBalance } from "@/lib/ai-video";
import { ensureWorkerRunning } from "@/lib/render-capacity";
import { toLibraryAsset } from "@/lib/library";
import { prisma } from "@reelwalk/db";

export const runtime = "nodejs";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to use AI video." }, { status: 401 });
  const [balance, jobs] = await Promise.all([
    getAiBalance(user.workspaceId),
    prisma.aiGeneration.findMany({ where: { workspaceId: user.workspaceId }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const assets = await prisma.mediaAsset.findMany({ where: { workspaceId: user.workspaceId, id: { in: jobs.flatMap(j => j.assetId ? [j.assetId] : []) } } });
  const library = new Map(await Promise.all(assets.map(async a => [a.id, await toLibraryAsset(a)] as const)));
  const drafts = await prisma.reel.findMany({ where: { workspaceId: user.workspaceId, id: { in: jobs.map(j => `ai-promo-${j.id}`) } }, select: { id: true } });
  const draftIds = new Set(drafts.map(d => d.id));
  if (jobs.some(j => ["QUEUED", "SUBMITTING", "RUNNING"].includes(j.status))) await ensureWorkerRunning();
  return Response.json({ enabled: aiVideoConfigured(), balance, jobs: jobs.map(j => ({
    id: j.id, prompt: j.prompt, status: j.status, error: j.error, shot: j.shot,
    draftId: draftIds.has(`ai-promo-${j.id}`) ? `ai-promo-${j.id}` : null,
    createdAt: j.createdAt.toISOString(), asset: j.assetId ? library.get(j.assetId) ?? null : null,
  })) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to use AI video." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const input = generationInput.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "Describe your shot in 10–2,000 characters." }, { status: 400 });
  try {
    const job = await createAiGeneration(user, input.data);
    await ensureWorkerRunning();
    return Response.json({ id: job.id }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not start generation." }, { status: 409 });
  }
}
