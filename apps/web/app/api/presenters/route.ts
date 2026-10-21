import { getSessionUser } from "@/lib/auth";
import { createPresenter, listPresenters, PresenterError } from "@/lib/presenters";
import { ensureWorkerRunning } from "@/lib/render-capacity";

export const runtime = "nodejs";

/** The workspace's presenter kits (ADR 0056). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to see your presenters." }, { status: 401 });
  return Response.json({ presenters: await listPresenters(user.workspaceId) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to set up a presenter." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const presenter = await createPresenter(user.workspaceId, await request.json().catch(() => null));
    // The worker cuts her face reference from the portrait.
    await ensureWorkerRunning();
    return Response.json({ presenter }, { status: 201 });
  } catch (error) {
    if (error instanceof PresenterError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
