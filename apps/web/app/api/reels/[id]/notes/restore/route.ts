import { getSessionUser } from "@/lib/auth";
import { restoreVersion } from "@/lib/reel-thread";

export const dynamic = "force-dynamic";

/** "Back to vN" (ADR 0095): `{ exportId }` makes that version's cut the reel's cut again, as a new revision. Renders nothing. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { exportId?: unknown } | null;
  if (typeof body?.exportId !== "string") return Response.json({ ok: false, message: "Say which version." }, { status: 400 });
  const { id } = await params;
  const restored = await restoreVersion(user, id, body.exportId);
  if (!restored.ok) return Response.json({ ok: false, message: restored.message }, { status: restored.status });
  return Response.json(restored);
}
