import { aiOffResponse } from "@/lib/ai-gate";
import { appUrl } from "@/lib/app-url";
import { getSessionUser } from "@/lib/auth";
import { startCreate } from "@/lib/create-reels";

export const dynamic = "force-dynamic";

/**
 * Create (ADR 0098). POST `{ idea, mediaIds?, options?, captions? }` makes one
 * reel per option and starts each one's create run in the background, then
 * answers at once with the reels; the Create page follows each reel's thread
 * (GET /api/reels/<id>/notes) until its first version is ready.
 */
export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }
  const body = (await request.json().catch(() => null)) as { idea?: unknown; mediaIds?: unknown; options?: unknown; captions?: unknown } | null;
  if (typeof body?.idea !== "string") return Response.json({ ok: false, message: "Describe the video first." }, { status: 400 });
  const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64) : [];
  const started = await startCreate({
    user,
    idea: body.idea,
    mediaIds,
    options: typeof body.options === "number" ? body.options : 3,
    captions: body.captions !== false,
    origin: await appUrl(),
  });
  if (!started.ok) return Response.json({ ok: false, message: started.message, upgrade: started.upgrade ?? false }, { status: started.status });
  return Response.json(started);
}
