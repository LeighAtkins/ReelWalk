import { clipStartsMs, reelSources, sourcesCaption, transformScore, untouchedStockClips } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { mediaScope } from "@/lib/media-scope";
import { readTimeline } from "@/lib/reels";

export const dynamic = "force-dynamic";

/**
 * The licence trail of a reel (ADR 0070): `GET /api/reels/:id/sources` lists
 * every stock clip the reel uses once, with its source, id, creator, page,
 * licence, import time and the clips that show it, plus the caption lines
 * that credit them. Read off the assets' own columns; nothing else is stored.
 *
 * `transforms` says, per clip, how much it was changed from its file (recut,
 * speed, grade, colour match, zoom, move, titles), and `untouched` names the
 * stock clips that went out as downloaded, for the critic (W3-F).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, error: "Sign in to see the reel's sources." }, { status: 401 });
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { timeline: true } });
  if (!reel) return Response.json({ ok: false, error: "No such reel." }, { status: 404 });
  const timeline = readTimeline(reel.timeline);
  const assetIds = [...new Set(timeline.clips.map((clip) => clip.assetId))];
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: assetIds }, ...mediaScope(user.workspaceId) },
    select: { id: true, sourceUrl: true, license: true, attribution: true, createdAt: true, durationMs: true },
  });
  const sources = reelSources(timeline, Object.fromEntries(assets.map((asset) => [asset.id, asset])));
  const stockAssetIds = new Set(sources.map((source) => source.assetId));
  const durations = Object.fromEntries(assets.map((asset) => [asset.id, asset.durationMs]));
  const starts = clipStartsMs(timeline);
  const transforms = timeline.clips.map((clip, index) => ({
    clipId: clip.id,
    assetId: clip.assetId,
    stock: stockAssetIds.has(clip.assetId),
    ...transformScore(clip, { texts: timeline.texts, clipStartMs: starts[index], sourceDurationMs: durations[clip.assetId] }),
  }));
  const untouched = untouchedStockClips(timeline, (assetId) => stockAssetIds.has(assetId), durations);
  return Response.json({ ok: true, sources, caption: sourcesCaption(sources), transforms, untouched }, { headers: { "Cache-Control": "private, no-store" } });
}
