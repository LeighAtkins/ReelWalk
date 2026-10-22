import { getSessionUser } from "@/lib/auth";
import { applySoundCommand } from "@/lib/sound";
import { readSoundCommand, toTimelineCommand } from "@/lib/sound-commands";

export const dynamic = "force-dynamic";

/**
 * Sound commands over HTTP (ADR 0066), for agents building a reel: the body
 * is `{ "command": { "type": "autoSfx" | "setSfx" | "dropOnCut", ... } }`
 * (see lib/sound-commands.ts). The command is applied to the saved reel
 * through the command layer (ADR 0048) and saved as a new revision; the
 * answer carries the placed sounds and the music so the agent can read
 * what landed. GET /api/reels/:id/audio-trace shows the result in time.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const read = readSoundCommand(await request.json().catch(() => null));
  if (!read.ok) return Response.json({ ok: false, message: read.message }, { status: 400 });
  const result = await applySoundCommand(user.workspaceId, id, (context) => toTimelineCommand(read.command, context));
  if (!result.ok) return Response.json({ ok: false, message: result.message }, { status: result.status });
  return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
