import { z } from "zod";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { durableAiJobs, startDirectorRun } from "@/lib/workflows";

export const runtime = "nodejs";

const body = z.object({ requestId: z.string().uuid(), brief: z.string().trim().min(3).max(4000), budgetCredits: z.number().int().min(1).max(40) });

/**
 * Starts a persisted "make it for me" run (ADR 0037 loop, ADR 0049 state):
 * the round, credits used and the stop flag live in the database, so the
 * sheet can be closed, reloaded, or the web app restarted mid-run.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "Sign in to direct this reel." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ ok: false, message: "Invalid request origin." }, { status: 403 });
  // Without the durable path the sheet keeps its in-tab loop (ADR 0037).
  if (!durableAiJobs()) return Response.json({ ok: false, durable: false, message: "Saved runs are not enabled." }, { status: 409 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, message: "Describe the reel and choose a budget." }, { status: 400 });
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true } });
  if (!reel) return Response.json({ ok: false, message: "Reel not found." }, { status: 404 });
  const started = await startDirectorRun({ user, reelId: id, ...parsed.data });
  return started.ok ? Response.json({ ok: true, run: started.run }) : Response.json({ ok: false, message: started.message }, { status: started.status });
}
