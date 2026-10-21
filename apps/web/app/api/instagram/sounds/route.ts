import { chooseInstagramSound, popularInstagramSounds, searchInstagramSounds } from "@/app/instagram-audio-actions";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Searching and choosing Instagram sounds from the editor. A plain route
 * rather than server actions: an action's id changes with every deploy, so a
 * Music sheet left open across one could no longer search ("Could not reach
 * ReelWalk"); this URL stays the same. The actions do the work.
 */
export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  if (!(await getSessionUser())) return Response.json({ ok: false, error: "You were signed out. Sign in again." }, { status: 401 });
  let body: { action?: unknown; type?: unknown; query?: unknown; audioId?: unknown; title?: unknown; artist?: unknown; moods?: unknown; reelMs?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Could not read the request." }, { status: 400 });
  }
  if (body.action === "search") return Response.json(await searchInstagramSounds({ type: String(body.type ?? "music"), query: String(body.query ?? "") }));
  if (body.action === "popular") return Response.json(await popularInstagramSounds({ moods: body.moods, reelMs: body.reelMs }));
  if (body.action === "choose") {
    return Response.json(
      await chooseInstagramSound({ audioId: String(body.audioId ?? ""), type: String(body.type ?? "music"), title: String(body.title ?? ""), artist: typeof body.artist === "string" ? body.artist : null }),
    );
  }
  return Response.json({ ok: false, error: "Unknown request." }, { status: 400 });
}
