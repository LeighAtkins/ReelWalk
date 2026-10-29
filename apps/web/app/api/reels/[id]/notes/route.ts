import { aiOffResponse } from "@/lib/ai-gate";
import { appUrl } from "@/lib/app-url";
import { getSessionUser } from "@/lib/auth";
import { reelThread, startNote } from "@/lib/reel-thread";

export const dynamic = "force-dynamic";

/**
 * Notes on a version (ADR 0095). POST `{ note, requestId? }` starts one in
 * the background and answers at once with its id; the export screen refreshes
 * until the new version is there. GET is the reel's thread: its versions
 * (newest first, with their checks) and the notes that made them.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  { const off = await aiOffResponse(user.workspaceId); if (off) return off; }
  const body = (await request.json().catch(() => null)) as { note?: unknown; requestId?: unknown } | null;
  if (typeof body?.note !== "string") return Response.json({ ok: false, message: "Write the note first." }, { status: 400 });
  const { id } = await params;
  const requestId = typeof body.requestId === "string" && /^[0-9a-f-]{36}$/i.test(body.requestId) ? body.requestId : crypto.randomUUID();
  const started = await startNote({ user, reelId: id, note: body.note, origin: await appUrl(), requestId });
  if (!started.ok) return Response.json({ ok: false, message: started.message, upgrade: started.upgrade ?? false }, { status: started.status });
  return Response.json({ ok: true, noteId: started.noteId, jobId: started.jobId });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const thread = await reelThread(user.workspaceId, id);
  return Response.json({ ok: true, ...thread }, { headers: { "Cache-Control": "private, no-store" } });
}
