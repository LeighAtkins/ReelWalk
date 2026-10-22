import { AUDIO_ANALYSIS_VERSION, musicFieldsFromAnalysis, parseAudioAnalysis } from "@reelwalk/core";
import { getSessionUser } from "@/lib/auth";
import { findSoundAsset, readStoredAnalysis, storeAnalysis } from "@/lib/sound";
import { durableAiJobs, startMusicAnalysisRun } from "@/lib/workflows";

export const dynamic = "force-dynamic";

const AUDIO_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A track's analysis (ADR 0066): beat grid, downbeats, sections, energy
 * curve and the first drop, cached beside the sound's file. `audioId` is an
 * Instagram audio id (the workspace's private copy, ADR 0019) or a media
 * asset id. 200 with the analysis when it is cached; 202 while the worker
 * makes it (`jobId` polls /api/ai-jobs/:id), or, without durable jobs, 202
 * asking the browser to PUT its own (the editor does this when it decodes
 * the sound for its tempo). `music` carries the fields `setMusic` takes.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ audioId: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { audioId } = await params;
  if (!AUDIO_ID.test(audioId)) return Response.json({ ok: false, message: "That is not a sound id." }, { status: 400 });
  const asset = await findSoundAsset(user.workspaceId, audioId);
  if (!asset) return Response.json({ ok: false, message: "That sound is not in this workspace. Choose it in the editor first." }, { status: 404 });
  const analysis = await readStoredAnalysis(asset.objectKey);
  const headers = { "Cache-Control": "private, no-store" };
  if (analysis) return Response.json({ ok: true, status: "ready", assetId: asset.id, analysis, music: musicFieldsFromAnalysis(analysis) }, { headers });
  if (!durableAiJobs()) {
    return Response.json({ ok: true, status: "pending", assetId: asset.id, jobId: null, message: "Not analysed yet. The editor analyses the sound when it is chosen; or PUT an analysis here." }, { status: 202, headers });
  }
  const started = await startMusicAnalysisRun(user, asset.id, AUDIO_ANALYSIS_VERSION);
  if (!started.ok) return Response.json({ ok: false, message: started.message }, { status: started.status });
  return Response.json({ ok: true, status: "pending", assetId: asset.id, jobId: started.jobId, message: "Analysing the track. Poll /api/ai-jobs/:jobId, then ask again." }, { status: 202, headers });
}

/**
 * The browser's analysis of the same sound (the editor decodes the private
 * copy to find its tempo and runs the same pure code), stored so agents and
 * the export page read it without a worker. Same shape as GET's `analysis`.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ audioId: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { audioId } = await params;
  if (!AUDIO_ID.test(audioId)) return Response.json({ ok: false, message: "That is not a sound id." }, { status: 400 });
  const asset = await findSoundAsset(user.workspaceId, audioId);
  if (!asset) return Response.json({ ok: false, message: "That sound is not in this workspace." }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { analysis?: unknown } | null;
  const analysis = parseAudioAnalysis(body && typeof body === "object" && "analysis" in body ? body.analysis : body);
  if (!analysis) return Response.json({ ok: false, message: `Could not read the analysis (version ${AUDIO_ANALYSIS_VERSION} expected).` }, { status: 400 });
  await storeAnalysis(asset, analysis);
  return Response.json({ ok: true, status: "ready", assetId: asset.id, analysis, music: musicFieldsFromAnalysis(analysis) }, { headers: { "Cache-Control": "private, no-store" } });
}
