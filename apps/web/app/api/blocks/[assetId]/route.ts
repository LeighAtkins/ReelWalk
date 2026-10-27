import { getSessionUser } from "@/lib/auth";
import { blockSolveRequestId, findBlockClip, readBlockState } from "@/lib/walk-block";
import { durableAiJobs, startWorkerStepRun } from "@/lib/workflows";

export const dynamic = "force-dynamic";

const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const headers = { "Cache-Control": "private, no-store" };

/**
 * Walk the block (ADR 0093): a drone clip read in 3D. GET answers 200 with `status` "ready" (the solve: cameras in
 * metres, ground, scale, sun, and a URL of the still to pin on), "refused" (the clip cannot be read, with the reason
 * for the person), or "missing" (not read yet: POST to start). POST starts the read, free, in the worker: 202 with a
 * `jobId` to poll at /api/ai-jobs/:id, then GET again. Asking again for the same clip resumes the same read.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { assetId } = await params;
  if (!ASSET_ID.test(assetId)) return Response.json({ ok: false, message: "That is not a clip id." }, { status: 400 });
  const asset = await findBlockClip(user.workspaceId, assetId);
  if (!asset) return Response.json({ ok: false, message: "That clip is not in this workspace." }, { status: 404 });
  return Response.json({ ok: true, ...(await readBlockState(asset)) }, { headers });
}

export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { assetId } = await params;
  if (!ASSET_ID.test(assetId)) return Response.json({ ok: false, message: "That is not a clip id." }, { status: 400 });
  const asset = await findBlockClip(user.workspaceId, assetId);
  if (!asset) return Response.json({ ok: false, message: "That clip is not in this workspace." }, { status: 404 });
  const state = await readBlockState(asset);
  if (state.status !== "missing") return Response.json({ ok: true, ...state }, { headers });
  if (!durableAiJobs()) return Response.json({ ok: false, message: "Walk the block needs the render worker, which is not set up here." }, { status: 503 });
  const started = await startWorkerStepRun({ user, kind: "block-solve", requestId: blockSolveRequestId(asset.id), payload: { assetId: asset.id } });
  if (!started.ok) return Response.json({ ok: false, message: started.message }, { status: started.status });
  return Response.json({ ok: true, status: "pending", assetId: asset.id, jobId: started.jobId, message: "Reading the land in 3D. Poll /api/ai-jobs/:jobId, then GET again." }, { status: 202, headers });
}
