import { applyCommand, colorStatsSchema, lookDistance, matchableClips, type ColorStats, type Timeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { measureReelLook } from "@/lib/look-measure";
import { readTimeline } from "@/lib/reels";

export const dynamic = "force-dynamic";

/**
 * One coherent look over HTTP (ADR 0070), for the agents that build the
 * owner's reels.
 *
 * `GET /api/reels/:id/look` says which clip is the reference, at what
 * strength, and how far each clip's measured look is from it.
 *
 * `POST /api/reels/:id/look { referenceClipId?, strength?, stats? }` runs the
 * `matchLook` command on the saved reel: clips not yet measured (and not
 * given in `stats`) are measured here on their poster frame, then every
 * measured clip is matched to the reference. `referenceClipId` absent keeps
 * the reel's reference; `null` clears the match. An editor left open sees
 * the new revision as a save conflict, as with any server-side edit.
 */
const bodySchema = z.object({
  referenceClipId: z.string().min(1).nullable().optional(),
  strength: z.number().min(0).max(1).optional(),
  stats: z.record(z.string(), colorStatsSchema).optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, error: "Sign in to see the reel's look." }, { status: 401 });
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { timeline: true, revision: true } });
  if (!reel) return Response.json({ ok: false, error: "No such reel." }, { status: 404 });
  const timeline = readTimeline(reel.timeline);
  return Response.json({ ok: true, revision: reel.revision, ...describe(timeline) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, error: "Sign in to match the look." }, { status: 401 });
  const body = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!body.success) {
    return Response.json({ ok: false, error: "Could not read the request: referenceClipId (string or null), strength (0..1), stats (by clip id)." }, { status: 400 });
  }
  const { id } = await params;
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { timeline: true, revision: true } });
  if (!reel) return Response.json({ ok: false, error: "No such reel." }, { status: 404 });
  const timeline = readTimeline(reel.timeline);

  // Measure what is not measured yet, unless the match is being cleared.
  const given = body.data.stats ?? {};
  let measured: { stats: Record<string, ColorStats>; unmeasured: string[] } = { stats: {}, unmeasured: [] };
  if (body.data.referenceClipId !== null) {
    const missing = matchableClips(timeline).filter((clip) => !clip.colorStats && !given[clip.id]);
    if (missing.length > 0) measured = await measureReelLook(user.workspaceId, { ...timeline, clips: missing });
  }
  const command = { type: "matchLook" as const, referenceClipId: body.data.referenceClipId, strength: body.data.strength, stats: { ...measured.stats, ...given } };
  const result = applyCommand(timeline, command, { generation: reel.revision });
  if (result.rejected) return Response.json({ ok: false, error: result.rejected, unmeasured: measured.unmeasured }, { status: 400 });
  let revision = reel.revision;
  if (result.changes.length > 0) {
    const updated = await prisma.reel.updateMany({
      where: { id, workspaceId: user.workspaceId, revision: reel.revision },
      data: { timeline: result.timeline, revision: { increment: 1 } },
    });
    if (updated.count === 0) return Response.json({ ok: false, error: "The reel changed while the look was being matched. Try again." }, { status: 409 });
    revision += 1;
  }
  return Response.json(
    {
      ok: true,
      revision,
      changed: result.changes.length,
      measuredHere: Object.keys(measured.stats).length,
      /** Server measurements read one poster frame per clip; the editor reads three frames of the clip's window. */
      framesPerClip: 1,
      unmeasured: measured.unmeasured,
      ...describe(result.timeline),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/** The reel's look as the response says it: the reference, the strength, and each clip's distance from the reference. */
function describe(timeline: Timeline) {
  const reference = timeline.look ? timeline.clips.find((clip) => clip.id === timeline.look?.referenceClipId) : undefined;
  const target = reference?.colorStats;
  return {
    look: timeline.look ?? null,
    clips: timeline.clips.map((clip) => ({
      id: clip.id,
      assetId: clip.assetId,
      measured: Boolean(clip.colorStats),
      matched: Boolean(clip.colorMatch),
      /** How far this clip's own look is from the reference's, before matching (about 0.03 shows at a cut). */
      distance: target && clip.colorStats ? lookDistance(clip.colorStats, target) : null,
    })),
  };
}
