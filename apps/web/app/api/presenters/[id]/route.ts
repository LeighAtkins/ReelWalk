import { getSessionUser } from "@/lib/auth";
import { PresenterError, updatePresenter } from "@/lib/presenters";
import { ensureWorkerRunning } from "@/lib/render-capacity";

export const runtime = "nodejs";

/** Rename a presenter kit, swap its photos, or make it the workspace default (ADR 0056). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to change a presenter." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const { id } = await params;
  try {
    const presenter = await updatePresenter(user.workspaceId, id, await request.json().catch(() => null));
    if (!presenter.ready) await ensureWorkerRunning();
    return Response.json({ presenter });
  } catch (error) {
    if (error instanceof PresenterError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
