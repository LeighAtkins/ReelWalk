import { FINISH_IDS, pickFinishSong, type FinishId } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { context } from "@/lib/ai-edit";
import { toLibraryAssets } from "@/lib/library";
import { readTimeline } from "@/lib/reels";
import { mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * The song for "Make it pop" / "Make it premium" (ADR 0064): from the same
 * list Ask and Make it for me choose from (Instagram's sounds where the studio
 * can use them, else the library, the studio's own first). Nothing is changed
 * here: the editor fetches the song and applies the finish as one command.
 * `song: null` means keep the song the reel has.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, timeline: true } });
  if (!reel) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { finish?: unknown; assetId?: unknown; instagramAudioId?: unknown; autoPicked?: unknown };
  if (!FINISH_IDS.includes(body.finish as FinishId)) return Response.json({ ok: false, message: "Unknown finish." }, { status: 400 });
  // A song the studio picked itself stays: no need to look at the list.
  if (typeof body.assetId === "string" && body.autoPicked !== true) return Response.json({ ok: true, song: null });
  const { songs } = await context(user.workspaceId, readTimeline(reel.timeline));
  const song = pickFinishSong(songs, body.finish as FinishId, {
    assetId: typeof body.assetId === "string" ? body.assetId : null,
    instagramAudioId: typeof body.instagramAudioId === "string" ? body.instagramAudioId : null,
    autoPicked: body.autoPicked === true,
  });
  if (!song) return Response.json({ ok: true, song: null });
  if (song.instagram) return Response.json({ ok: true, song: { title: song.title, instagram: song.instagram } });
  const [asset] = await toLibraryAssets(await prisma.mediaAsset.findMany({ where: { id: song.id, ...mediaScope(user.workspaceId) } }));
  return Response.json({ ok: true, song: asset ? { title: song.title, asset } : null });
}
