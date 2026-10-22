import type { Command } from "@reelwalk/core";
import { getSessionUser } from "@/lib/auth";
import { applyReelCommand, loadReel } from "@/lib/reel-command";

export const dynamic = "force-dynamic";

/** Every command the editor's document store accepts (ADR 0048, 0059, 0060, 0062, 0064, 0068). */
const COMMAND_TYPES = new Set<Command["type"]>([
  "trimClip", "moveClip", "splitClip", "deleteClip", "duplicateClip", "setSpeed", "setMusic", "snapToBeat", "pace", "setOnBeat",
  "retime", "retimeToLength", "insertPresenterTakes", "applyFinish", "hook", "applyProposal", "updateText", "addText", "batch",
]);

/**
 * One document command against the saved reel (ADR 0068):
 * `{ command: { type: "hook", pattern: "voice-in", titles?, promise? }, revision? }`.
 * Same origin, signed in, the reel in the workspace. The command runs through
 * the same pure `applyCommand` as the editor and is saved at the reel's
 * revision; a reel changed in between answers 409. A command the reel cannot
 * take (a pattern that cannot be made, a missing clip) answers 400 with the
 * reason. Returns the new revision, what changed and the reel as saved.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { command?: unknown; revision?: unknown } | null;
  const command = body?.command as Partial<Command> | undefined;
  if (!command || typeof command !== "object" || typeof command.type !== "string" || !COMMAND_TYPES.has(command.type)) {
    return Response.json({ ok: false, message: `Send { command: { type, ... } }; type is one of ${[...COMMAND_TYPES].join(", ")}.` }, { status: 400 });
  }
  const { id } = await params;
  const loaded = await loadReel(user, id);
  if (!loaded) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });
  const revision = typeof body?.revision === "number" ? body.revision : loaded.revision;
  const outcome = await applyReelCommand(user, loaded, command as Command, revision);
  if (!outcome.ok) return Response.json({ ok: false, message: outcome.message, changes: outcome.result?.changes ?? [] }, { status: outcome.status });
  const { timeline, changes, warning } = outcome.result;
  return Response.json({ ok: true, revision: outcome.revision, changes, warning: warning ?? null, opening: timeline.opening ?? null, timeline });
}
