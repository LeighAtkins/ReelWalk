import { aiOffResponse } from "@/lib/ai-gate";
import { appUrl } from "@/lib/app-url";
import { getSessionUser } from "@/lib/auth";
import { startCreate } from "@/lib/create-reels";

export const dynamic = "force-dynamic";

/**
 * Create (ADR 0098). POST `{ requestId, idea, mediaIds?, options?, captions?, voice? }`
 * makes one reel per option and starts each one's create run in the background,
 * then answers at once with the reels; the Create page follows each reel's
 * thread (GET /api/reels/<id>/notes) until its first version is ready.
 * `requestId` is the browser's, kept across retries: the same id answers with
 * the same reels (resuming any option not yet started), and the same id with a
 * different payload is refused (409).
 */
export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }
  const body = (await request.json().catch(() => null)) as { requestId?: unknown; idea?: unknown; mediaIds?: unknown; options?: unknown; captions?: unknown; voice?: unknown } | null;
  if (typeof body?.idea !== "string") return Response.json({ ok: false, message: "Describe the video first." }, { status: 400 });
  const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64) : [];
  const started = await startCreate({
    user,
    requestId: typeof body.requestId === "string" ? body.requestId : "",
    idea: body.idea,
    mediaIds,
    options: typeof body.options === "number" ? body.options : 3,
    captions: body.captions !== false,
    voice: typeof body.voice === "string" && body.voice ? body.voice : null,
    origin: await appUrl(),
  });
  if (!started.ok) return Response.json({ ok: false, message: started.message, upgrade: started.upgrade ?? false, ...(started.reason ? { reason: started.reason } : {}) }, { status: started.status });
  return Response.json(started);
}
