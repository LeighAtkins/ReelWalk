import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { loadShotAnalyses } from "@/lib/shot-analysis";
import { readTimeline } from "@/lib/reels";

export const dynamic = "force-dynamic";

/**
 * The full shot analyses (ADR 0086) of a reel's videos, by asset id: per-moment quality, flow, saliency, best windows,
 * motion segments, flow peaks, depth, occluders, the 9:16 reframe and scene facts (`shotAnalysisSchema` in
 * @reelwalk/core). For the cut planner and agents that choose in-points and transitions; MCP get_reel carries a digest.
 * `?assetIds=a,b` reads other workspace videos too (a planner choosing from the library). A video not analysed yet is
 * listed in `pending`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { timeline: true } });
  if (!reel) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });
  const extra = (new URL(request.url).searchParams.get("assetIds") ?? "").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 60);
  const timeline = readTimeline(reel.timeline);
  const videos = [...new Set([...timeline.clips.filter((clip) => clip.kind === "VIDEO").map((clip) => clip.assetId), ...extra])];
  const analyses = await loadShotAnalyses(user.workspaceId, videos);
  return Response.json({ ok: true, analyses, pending: videos.filter((assetId) => !analyses[assetId]) });
}
