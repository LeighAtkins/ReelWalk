import { aiOffResponse } from "@/lib/ai-gate";
import { getSessionUser } from "@/lib/auth";
import { createPlanSchema, createShotPlan, listShotPlans, ShotPlanError } from "@/lib/shot-plans";

export const dynamic = "force-dynamic";
// Planning is one model request (and at most one repair round): give it time.
export const maxDuration = 120;

/**
 * Shot plans (ADR 0104).
 * GET: the workspace's plans, newest first.
 * POST `{ brief, approval?, presenterId?, referenceId?, mediaIds?, budgetCredits? }`: plans a sequence and saves it
 * unstarted, with its continuity issues and credit estimate; nothing is made or spent until it is started.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  return Response.json({ ok: true, plans: await listShotPlans(user.workspaceId) });
}

export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }
  const parsed = createPlanSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, message: "Describe the video in a sentence or two." }, { status: 400 });
  try {
    return Response.json({ ok: true, plan: await createShotPlan(user, parsed.data) });
  } catch (error) {
    if (error instanceof ShotPlanError) return Response.json({ ok: false, message: error.message }, { status: 400 });
    console.error("shot plan: planning failed", error);
    return Response.json({ ok: false, message: "The plan could not be made. Try again in a minute." }, { status: 502 });
  }
}
