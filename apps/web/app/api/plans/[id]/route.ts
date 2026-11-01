import { aiOffResponse } from "@/lib/ai-gate";
import { getSessionUser } from "@/lib/auth";
import { actOnShotPlan, getShotPlan, planActionSchema, planMedia, ShotPlanError } from "@/lib/shot-plans";

export const dynamic = "force-dynamic";

/** One shot plan (ADR 0104): its shots, storyboard, takes and their checks. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const plan = await getShotPlan(user.workspaceId, id);
  if (!plan) return Response.json({ ok: false, message: "That plan is not in this workspace." }, { status: 404 });
  return Response.json({ ok: true, plan, media: await planMedia(user.workspaceId, plan) });
}

/**
 * The owner's decisions: `{ action: "start", confirmCredits }` (the budget, repeated), "approve_storyboard",
 * "accept_take" `{ shotId, aiShotId }`, "redo" `{ shotId, note? }`, "stop", "edit" `{ plan }` (before any take).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }
  const parsed = planActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, message: "That is not something a plan can do." }, { status: 400 });
  const { id } = await params;
  try {
    return Response.json({ ok: true, plan: await actOnShotPlan(user.workspaceId, id, parsed.data) });
  } catch (error) {
    if (error instanceof ShotPlanError || (error instanceof Error && error.name === "ZodError")) return Response.json({ ok: false, message: error.message.slice(0, 300) }, { status: 400 });
    if (error instanceof Error && /not one of this shot's|was not made|No shot/.test(error.message)) return Response.json({ ok: false, message: error.message }, { status: 400 });
    throw error;
  }
}
