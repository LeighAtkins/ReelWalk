import { groupStock, passesStockFilters, type StockFilters } from "@reelwalk/core";
import { getSessionUser } from "@/lib/auth";
import { isStockConfigured, searchStockClips } from "@/lib/stock";
import { checkStockClips } from "@/lib/stock-check";

export const dynamic = "force-dynamic";

/** Most clips the frame checks look at per search: each is a vision call, and the first sets are what the thumb sees. */
const CHECK_LIMIT = 24;

/**
 * Coherent stock search (ADR 0070): `GET /api/stock/search?q=villa+pool&group=creator`
 * answers with sets of clips from one creator and one shoot, so one tap adds
 * footage of one place. Filters: `portrait=1` (default on), `minMs`, `maxMs`,
 * `people=0` (no people, default on), `text=0` (no burnt-in text or watermark,
 * default on), `check=0` to skip the frame checks and go by tags alone.
 * Every clip carries `checks` (null fields when a check did not run) so the
 * caller can tell a verified clip from a tag-filtered one.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, error: "Sign in to search stock." }, { status: 401 });
  if (!isStockConfigured()) return Response.json({ ok: false, unconfigured: true, error: "Stock search needs a free Pixabay API key (PIXABAY_API_KEY)." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  if (!q) return Response.json({ ok: false, error: "Say what to look for (q)." }, { status: 400 });
  const flag = (name: string, fallback: boolean) => { const value = params.get(name); return value === null ? fallback : value !== "0" && value !== "false"; };
  const number = (name: string) => { const value = Number(params.get(name)); return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined; };
  const filters: StockFilters = { portrait: flag("portrait", true), noPeople: !flag("people", false), noText: !flag("text", false), minMs: number("minMs"), maxMs: number("maxMs") };
  const check = flag("check", true);
  const perPage = Math.min(200, number("perPage") ?? 60);

  try {
    const hits = await searchStockClips(q, perPage);
    // Shape and length first (free), tags next (free), pixels last and only for the clips still in.
    const shaped = hits.filter((clip) => passesStockFilters(clip, { portrait: filters.portrait, minMs: filters.minMs, maxMs: filters.maxMs }));
    const byTags = shaped.filter((clip) => passesStockFilters(clip, { noPeople: filters.noPeople, noText: filters.noText }));
    const checked = check ? await checkStockClips(byTags, CHECK_LIMIT) : byTags;
    const kept = checked.filter((clip) => passesStockFilters(clip, filters));
    const clips = kept.map(({ sample: _sample, ...clip }) => { void _sample; return clip; });
    const groups = params.get("group") === "none" ? null : groupStock(clips);
    return Response.json({ ok: true, query: q, filters, checked: check ? Math.min(CHECK_LIMIT, byTags.length) : 0, total: hits.length, clips: groups ? undefined : clips, groups }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Stock search failed." }, { status: 502 });
  }
}
