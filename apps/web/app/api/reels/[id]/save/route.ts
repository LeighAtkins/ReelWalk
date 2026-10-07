import { getSessionUser } from "@/lib/auth";
import { saveReelFor } from "@/lib/save-reel";

export const dynamic = "force-dynamic";

/**
 * The editor's autosave. A plain route rather than a server action: action
 * ids change with every deploy, so an editor left open across a deploy could
 * no longer save; this URL stays the same.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Only this site's pages may save (the session cookie is SameSite=Lax, and
  // a JSON body already forces a CORS preflight; this is the explicit check).
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, reason: "invalid", message: "Cross-site save refused." }, { status: 403 });

  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, reason: "signed-out", message: "You were signed out. Sign in again to keep saving." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, reason: "invalid", message: "Could not read the changes." }, { status: 400 });
  }
  const { id } = await params;
  return Response.json(await saveReelFor(user, { ...body, id }));
}
