import { blockPinSchema } from "@reelwalk/core";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { findBlockClip, readBlockState } from "@/lib/walk-block";
import { durableAiJobs, startWorkerStepRun } from "@/lib/workflows";

export const dynamic = "force-dynamic";

const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const bodySchema = z.object({ requestId: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/), pin: blockPinSchema });

/**
 * Walk the block (ADR 0093): draw the reveal on a clip that has been read. Body `{ requestId, pin }` (`blockPinSchema`
 * in core: the build, where its outline sits in the solve's metres, its heading and true size, the crop, the sun and
 * the scale). 202 with a `jobId`; polling /api/ai-jobs/:jobId gives `{ assetId, reelId }`: the reveal clip and a new
 * reel that opens on it. Free: drawn from the solve, no AI video. The same request id resumes; a changed pin needs a
 * new one.
 */
export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { assetId } = await params;
  if (!ASSET_ID.test(assetId)) return Response.json({ ok: false, message: "That is not a clip id." }, { status: 400 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, message: "Could not read the outline. Place it again." }, { status: 400 });
  const asset = await findBlockClip(user.workspaceId, assetId);
  if (!asset) return Response.json({ ok: false, message: "That clip is not in this workspace." }, { status: 404 });
  const state = await readBlockState(asset);
  if (state.status !== "ready") return Response.json({ ok: false, message: state.status === "refused" ? state.message : "Read the land first (POST /api/blocks/:assetId)." }, { status: 409 });
  if (!durableAiJobs()) return Response.json({ ok: false, message: "Walk the block needs the render worker, which is not set up here." }, { status: 503 });
  const started = await startWorkerStepRun({ user, kind: "block-reveal", requestId: body.data.requestId, payload: { assetId: asset.id, pin: body.data.pin } });
  if (!started.ok) return Response.json({ ok: false, message: started.message }, { status: started.status });
  return Response.json({ ok: true, status: "pending", jobId: started.jobId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}
