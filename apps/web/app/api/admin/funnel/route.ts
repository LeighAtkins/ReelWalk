import { isAdmin } from "@/lib/admin";
import { getSessionUser } from "@/lib/auth";
import { funnelSummary } from "@/lib/funnel";

export const dynamic = "force-dynamic";

/**
 * Funnel counts for the owner (ADR 0080): sign-ups, first exports, started
 * checkouts and subscriptions since `?days=` ago (default 30, at most 365),
 * in total and per utm_source and utm_campaign. Admins only (User.isAdmin);
 * anyone else gets a 404, as for /admin pages.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user || !isAdmin(user)) return Response.json({ error: "not found" }, { status: 404 });
  const requested = Number(new URL(request.url).searchParams.get("days") ?? 30);
  const days = Number.isFinite(requested) ? Math.min(365, Math.max(1, Math.round(requested))) : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return Response.json({ days, since: since.toISOString(), ...(await funnelSummary(since)) });
}
