import { getSessionUser } from "@/lib/auth";
import { reelAudioTrace } from "@/lib/sound";

export const dynamic = "force-dynamic";

/**
 * What an agent (and the critic, ADR 0062) reads instead of listening (ADR
 * 0066): the reel's beats, cuts, speech and placed sounds in reel time, the
 * last export's loudness every 250 ms when one has been rendered, the
 * recommended post sound volume and the problems a sound editor would flag.
 * The JSON shape is documented in the ADR.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const { id } = await params;
  const trace = await reelAudioTrace(user.workspaceId, id);
  if (!trace) return Response.json({ ok: false, message: "That reel was not found." }, { status: 404 });
  return Response.json({ ok: true, ...trace }, { headers: { "Cache-Control": "private, no-store" } });
}
