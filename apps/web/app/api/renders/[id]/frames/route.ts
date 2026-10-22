import { timelineDurationMs } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { contactSheet, exportTimeline, ffmpegAvailable, framesAt, parseTimes, parseWidth, VERIFY } from "@/lib/render-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Frames of a finished export (ADR 0071), for the signed-in studio's own
 * renders. `t` is a list of reel times in seconds (`0,0.5,1.5`; `1500ms`
 * also works; a negative value counts back from the end). `w` is the width
 * in px (default 270). One time answers a JPEG; several answer JSON with a
 * data URL each, or, with `sheet=1`, one JPEG with the frames side by side
 * in the order asked. The times served are in `X-Frame-Times` (ms).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to read this export." }, { status: 401 });
  const { id } = await params;
  const job = await prisma.renderJob.findFirst({ where: { id, workspaceId: user.workspaceId }, include: { output: true } });
  if (!job?.output) return Response.json({ error: "No finished export with that id." }, { status: 404 });
  if (!ffmpegAvailable()) return Response.json({ error: "Frames need ffmpeg on this server (set FFMPEG_PATH or install ffmpeg)." }, { status: 503 });

  const url = new URL(request.url);
  const timeline = exportTimeline(job.payload);
  const durationMs = timeline ? timelineDurationMs(timeline) : 10 * 60_000;
  const times = parseTimes(url.searchParams.get("t") ?? "0", durationMs);
  if (!times.length) return Response.json({ error: `Give reel times as t=0,0.5,1.5 (up to ${VERIFY.maxTimes}).` }, { status: 400 });
  const width = parseWidth(url.searchParams.get("w"));

  let frames: Buffer[];
  try {
    frames = await framesAt(job.output.objectKey, times, width);
  } catch (error) {
    return Response.json({ error: `Could not read the frames: ${error instanceof Error ? error.message : "unknown error"}` }, { status: 502 });
  }
  // The export's key is immutable (a retry renders to a new one), so a frame never changes.
  const headers = { "Cache-Control": "private, max-age=31536000, immutable", "X-Frame-Times": times.join(",") };
  const sheet = url.searchParams.get("sheet") === "1";
  if (sheet || (times.length === 1 && url.searchParams.get("format") !== "json")) {
    const body = sheet ? await contactSheet(frames, width) : frames[0];
    return new Response(new Uint8Array(body), { headers: { ...headers, "Content-Type": "image/jpeg" } });
  }
  return Response.json(
    { jobId: job.id, width, frames: times.map((ms, index) => ({ ms, jpeg: `data:image/jpeg;base64,${frames[index].toString("base64")}` })) },
    { headers },
  );
}
