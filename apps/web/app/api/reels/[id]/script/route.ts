import { z } from "zod";
import { buildScriptShots, ScriptShotError, scriptRequestKey, scriptRequestSchema, SCRIPT_MAX_LINES } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { aiLipsyncConfigured, aiVideoConfigured, aiVoiceConfigured, createAiGeneration, getAiBalance } from "@/lib/ai-video";
import { scriptGenerationRequestId } from "@/lib/director-request";
import { ensureWorkerRunning } from "@/lib/render-capacity";
import { toLibraryAssets } from "@/lib/library";

export const runtime = "nodejs";

/** Takes the workspace may have generating at once (the reservation enforces the same limit). */
const IN_FLIGHT_LIMIT = 2;
const IN_FLIGHT = ["QUEUED", "SUBMITTING", "RUNNING"] as const;

/**
 * What Script mode can offer here: whether takes can be made, which voices, and the credits left.
 * With `?scriptId=`, that script's takes instead: their request ids are derived here, so the answer is exactly the
 * script's generations however many others the workspace has made since.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to use the presenter." }, { status: 401 });
  const { id } = await params;
  if (!await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true } })) return Response.json({ error: "This reel was deleted." }, { status: 404 });
  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (scriptId !== null) {
    if (!z.string().uuid().safeParse(scriptId).success) return Response.json({ error: "Unknown script." }, { status: 400 });
    const requestIds = Array.from({ length: SCRIPT_MAX_LINES }, (_, index) => scriptGenerationRequestId(user.workspaceId, scriptRequestKey(scriptId, index)));
    const [rows, inFlight] = await Promise.all([
      prisma.aiGeneration.findMany({ where: { workspaceId: user.workspaceId, requestId: { in: requestIds } }, select: { id: true, requestId: true, status: true, error: true, failureCode: true, assetId: true } }),
      prisma.aiGeneration.count({ where: { workspaceId: user.workspaceId, status: { in: [...IN_FLIGHT] } } }),
    ]);
    const assetIds = rows.flatMap(row => row.assetId ? [row.assetId] : []);
    const assets = assetIds.length ? new Map((await toLibraryAssets(await prisma.mediaAsset.findMany({ where: { workspaceId: user.workspaceId, id: { in: assetIds } } }))).map(asset => [asset.id, asset])) : new Map();
    if (rows.some(row => (IN_FLIGHT as readonly string[]).includes(row.status))) await ensureWorkerRunning().catch(() => undefined);
    return Response.json({
      jobs: rows.map(row => ({ index: requestIds.indexOf(row.requestId), id: row.id, status: row.status, error: row.error, failureCode: row.failureCode, asset: row.assetId ? assets.get(row.assetId) ?? null : null })),
      inFlight,
    }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const enabled = aiVideoConfigured() && aiVoiceConfigured();
  const balance = enabled ? await getAiBalance(user.workspaceId) : null;
  return Response.json({ enabled, voices: { veo: enabled, lipsync: enabled && aiLipsyncConfigured() }, remaining: balance?.remaining ?? 0 }, { headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Make a script's takes (ADR 0060). The studio approves the whole script's
 * quote once; the server rebuilds every prompt, duration and credit from the
 * lines and refuses a quote that does not match. Each take has a request id
 * derived from the script, so sending the same approval again never charges
 * a take twice: the editor sends it again as earlier takes finish, because
 * only two takes may generate at once.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to make presenter takes." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const body = z.object({ script: scriptRequestSchema, quotedCredits: z.number().int().positive(), approved: z.literal(true) }).safeParse(await request.json().catch(() => null));
  if (!body.success) {
    const words = body.error.issues.find(issue => /words or fewer|own footage/.test(issue.message));
    return Response.json({ error: words?.message ?? "Approve the script's lines and credit quote first." }, { status: 400 });
  }
  const { id } = await params;
  if (!await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true } })) return Response.json({ error: "This reel was deleted." }, { status: 404 });
  const { script, quotedCredits } = body.data;
  if (!aiVideoConfigured() || !aiVoiceConfigured()) return Response.json({ error: "Voiced takes are being connected. Please check back soon." }, { status: 409 });
  if (script.voice === "lipsync" && !aiLipsyncConfigured()) return Response.json({ error: "Lip sync is not set up yet. Use Veo's own voice." }, { status: 409 });

  let shots: ReturnType<typeof buildScriptShots>;
  try { shots = buildScriptShots(script, id); } catch (error) {
    if (error instanceof ScriptShotError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const total = shots.reduce((sum, shot) => sum + shot.credits, 0);
  if (quotedCredits !== total) return Response.json({ error: "The credit quote changed. Check the lines and approve again." }, { status: 409 });
  const requestIds = shots.map((_, index) => scriptGenerationRequestId(user.workspaceId, scriptRequestKey(script.scriptId, index)));
  const existing = await prisma.aiGeneration.findMany({ where: { workspaceId: user.workspaceId, requestId: { in: requestIds } }, select: { id: true, requestId: true } });
  const made = new Map(existing.map(row => [row.requestId, row.id]));
  // Start nothing unless every take still to make is covered: half a script is not what was approved.
  const owed = shots.reduce((sum, shot, index) => made.has(requestIds[index]) ? sum : sum + shot.credits, 0);
  if (owed > 0) {
    const { remaining } = await getAiBalance(user.workspaceId);
    if (owed > remaining) return Response.json({ error: `This script needs ${owed} more ${owed === 1 ? "credit" : "credits"} and ${remaining} ${remaining === 1 ? "is" : "are"} left. Add credits in Account or shorten a line.` }, { status: 409 });
  }

  const started: { index: number; id: string }[] = [];
  const waiting: number[] = [];
  // Why some takes wait: two are generating, or the hourly limit is reached. Both pass; the editor asks again later.
  let paused: "busy" | "hourly" | null = null;
  try {
    let inFlight = await prisma.aiGeneration.count({ where: { workspaceId: user.workspaceId, status: { in: [...IN_FLIGHT] } } });
    for (const [index, shot] of shots.entries()) {
      const known = made.get(requestIds[index]);
      if (known) { started.push({ index, id: known }); continue; }
      if (paused === "hourly" || inFlight >= IN_FLIGHT_LIMIT) { waiting.push(index); paused ??= "busy"; continue; }
      // The generation path every AI shot takes: kit, composed still, identity gate, credit reservation.
      let job: { id: string };
      try {
        job = await createAiGeneration(user, { requestId: requestIds[index], prompt: shot.prompt, durationSeconds: shot.durationSeconds, shot: shot.shot }, { exactPrompt: true });
      } catch (error) {
        // Another take started meanwhile: this one waits its turn rather than failing the script.
        if (error instanceof Error && /already generating/i.test(error.message)) { waiting.push(index); inFlight = IN_FLIGHT_LIMIT; paused ??= "busy"; continue; }
        if (error instanceof Error && /hourly generation limit/i.test(error.message)) { waiting.push(index); paused = "hourly"; continue; }
        throw error;
      }
      started.push({ index, id: job.id });
      inFlight += 1;
    }
    // The takes are reserved; a lost wake is picked up by the next poll of this script.
    if (started.length > existing.length) await ensureWorkerRunning().catch(() => undefined);
    return Response.json({ started, waiting, credits: total, ...(paused ? { paused } : {}) }, { status: 202 });
  } catch (error) {
    // Takes already started keep going; the same approval sent again carries on from here without charging them twice.
    return Response.json({ error: error instanceof Error ? error.message : "Could not start the takes.", started, waiting }, { status: 409 });
  }
}
