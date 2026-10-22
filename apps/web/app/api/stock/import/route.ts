import { getSessionUser } from "@/lib/auth";
import { importStockClips } from "@/lib/stock-import";

export const dynamic = "force-dynamic";

/**
 * Imports stock clips into the workspace's library (ADR 0070):
 * `POST /api/stock/import { ids: number[] }` (a set from `/api/stock/search`,
 * at most 12 at once). Answers with the library assets, each carrying its
 * `source` licence record, and any clip that could not be imported.
 */
export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, error: "Cross-site import refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, error: "Sign in to import stock." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 12);
  if (ids.length === 0) return Response.json({ ok: false, error: "Say which clips to import (ids)." }, { status: 400 });
  const { assets, failed } = await importStockClips(user.workspaceId, ids);
  return Response.json({ ok: true, assets, failed }, { headers: { "Cache-Control": "private, no-store" } });
}
