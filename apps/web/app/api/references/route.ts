import { aiOffResponse } from "@/lib/ai-gate";
import { getSessionUser } from "@/lib/auth";
import { listStyleReferences, startStyleReference } from "@/lib/style-references";

export const dynamic = "force-dynamic";

/**
 * Style references (ADR 0102).
 * GET: the workspace's references, newest first, with their recipes once read.
 * POST `{ mediaAssetId, sourceUrl?, title? }`: registers an uploaded video as a reference and starts its reading.
 * The same upload again answers with the same reference. The link is kept as a note only; nothing is fetched from it.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  return Response.json({ ok: true, references: await listStyleReferences(user.workspaceId) });
}

export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  // Reading the titles is a model request: a workspace with AI off cannot start one.
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }
  const body = (await request.json().catch(() => null)) as { mediaAssetId?: unknown; sourceUrl?: unknown; title?: unknown } | null;
  if (typeof body?.mediaAssetId !== "string" || !body.mediaAssetId || body.mediaAssetId.length > 64) {
    return Response.json({ ok: false, message: "Upload the reel's video first." }, { status: 400 });
  }
  const started = await startStyleReference({ user, mediaAssetId: body.mediaAssetId, sourceUrl: body.sourceUrl, title: body.title });
  if (!started.ok) return Response.json({ ok: false, message: started.message }, { status: started.status });
  return Response.json(started);
}
