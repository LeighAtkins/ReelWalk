import { getSessionUser } from "@/lib/auth";
import { getStyleReference } from "@/lib/style-references";

export const dynamic = "force-dynamic";

/** One style reference (ADR 0102): its status while it is read, then its recipe, summary and the effects not yet drawn. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const reference = await getStyleReference(user.workspaceId, id);
  if (!reference) return Response.json({ ok: false, message: "That reference is not in this workspace." }, { status: 404 });
  return Response.json({ ok: true, reference });
}
