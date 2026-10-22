import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { audioProblemsFrom, ensureChecks, ffmpegAvailable, gateFor, withAudio } from "@/lib/render-verify";
import { reelAudioTrace } from "@/lib/sound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The checks of a finished export (ADR 0071): near-black and flash frames,
 * an empty frame 0, frozen pictures, the loop seam, motion per second,
 * title reach into Instagram's zones, the opening title's legibility time,
 * the end against the song's bars; and the sound's problems from the reel's
 * audio trace (ADR 0066: off-beat cuts, speech under the music, the drop
 * mid-shot, holes in the measured export). The worker stores the picture
 * facts beside every export; with ffmpeg on this server they are computed
 * once for an older export. `fresh=1` recomputes. `gate` is what Post and
 * Schedule do.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to read this export." }, { status: 401 });
  const { id } = await params;
  const job = await prisma.renderJob.findFirst({ where: { id, workspaceId: user.workspaceId }, include: { output: true } });
  if (!job?.output) return Response.json({ error: "No finished export with that id." }, { status: 404 });

  const url = new URL(request.url);
  const headers = { "Cache-Control": "private, no-store" };
  let result;
  try {
    result = await ensureChecks(job, { fresh: url.searchParams.get("fresh") === "1" });
  } catch (error) {
    return Response.json({ jobId: job.id, checks: null, source: "none", reason: `The checks failed: ${error instanceof Error ? error.message : "unknown error"}` }, { status: 502, headers });
  }
  if (!result.checks) return Response.json({ jobId: job.id, checks: null, source: result.source, ffmpeg: ffmpegAvailable(), reason: result.reason }, { status: 503, headers });

  // The trace is read here, not fetched from this app's own route: a self-request fails behind a proxy or a
  // cookie prefix, and then the sound was reported unchecked although the trace answered.
  const trace = job.reelId ? await reelAudioTrace(user.workspaceId, job.reelId).catch(() => null) : null;
  const checks = withAudio(result.checks, audioProblemsFrom(trace));
  return Response.json({ jobId: job.id, reelId: job.reelId, source: result.source, ffmpeg: ffmpegAvailable(), gate: gateFor(checks), checks }, { headers });
}
