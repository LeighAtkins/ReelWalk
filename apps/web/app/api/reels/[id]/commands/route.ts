import type { Command } from "@reelwalk/core";
import { getSessionUser } from "@/lib/auth";
import { COMMAND_SHAPE as SHAPE, MAX_COMMANDS, inBatch, isCommand } from "@/lib/command-types";
import { applyReelCommand, loadReel } from "@/lib/reel-command";
import { resolveSurfaceCommands } from "@/lib/surface-command";

export const dynamic = "force-dynamic";

/**
 * Document commands against the saved reel, for the agents that build the
 * owner's reels (ADR 0067, ADR 0068, on ADR 0048's command boundary). The
 * accepted types are the core's own registry (`lib/command-types.ts`):
 * `{ command: Command, revision? }` runs one command, and
 * `{ commands: Command[], revision?, dryRun? }` runs several in order as one
 * batch (all land or none; no batch or proposal inside it). Same origin,
 * signed in, the reel in the workspace. The commands run through the same
 * pure `applyCommand` as the editor, with the library's source lengths and
 * transcripts filled in, and the result is saved at the reel's revision (the
 * current one when omitted); a reel changed in between answers 409. A command
 * the reel cannot take (a pattern that cannot be made, a missing clip) answers
 * 400 with the reason and nothing is saved. `dryRun: true` returns the result
 * without saving, so `matchCuts` can be asked for its suggestion first.
 * Returns the new revision, what changed and the reel as saved.
 *
 * `placeOnSurface { textId, clipId?, atMs?, pick? }` (ADR 0075) finds a surface in the picture at `atMs` (a wall, floor,
 * ceiling, sky band, snow or table, ranked), lays the title on it in the house serif with an ink chosen from the
 * surface, and tracks it through the shot when it has detail to follow; otherwise it is placed fixed and the answer
 * says so. `surfaces` in the answer lists what was found; with `dryRun: true` it is all that is done (nothing is
 * tracked or saved). `pick` is "auto" (the default), "wall", "floor", "ceiling", "sky", "tabletop", "ground" or
 * "window". Sending `placement.corners` yourself skips the search. `fit: { at: { x, y }, capHeight? }` (ADR 0084) lays the
 * line at that point of the surface with capitals that tall (a fraction of the frame), instead of filling the surface.
 *
 * `syncTextToSpeech { textId, clipId?, holdMs?, leadMs? }` (ADR 0084) times a title to the words it repeats in the clip
 * under it: it appears with the first word, each word arrives as it is said, and it fades `holdMs` after the last.
 * The transcripts are read from the library here.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "You were signed out. Sign in again." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { command?: unknown; commands?: unknown; revision?: unknown; dryRun?: unknown } | null;

  let command: Command;
  if (Array.isArray(body?.commands)) {
    const sent: unknown[] = body.commands;
    const commands = sent.filter(isCommand).filter(inBatch);
    if (sent.length === 0 || commands.length !== sent.length) return Response.json({ ok: false, message: SHAPE }, { status: 400 });
    if (commands.length > MAX_COMMANDS) return Response.json({ ok: false, message: `At most ${MAX_COMMANDS} commands per request.` }, { status: 400 });
    command = commands.length === 1 ? commands[0] : { type: "batch", commands };
  } else if (isCommand(body?.command)) {
    command = body.command;
  } else {
    return Response.json({ ok: false, message: SHAPE }, { status: 400 });
  }

  const { id } = await params;
  const loaded = await loadReel(user, id);
  if (!loaded) return Response.json({ ok: false, message: "This reel was deleted." }, { status: 404 });
  const revision = typeof body?.revision === "number" ? body.revision : loaded.revision;
  const dryRun = body?.dryRun === true;
  // A placeOnSurface with no placement is found from the picture first (ADR 0075): that needs frames, a model and the tracker.
  if (revision !== loaded.revision) return Response.json({ ok: false, message: "The reel changed since you read it. Read it again and send the command against its current revision.", changes: [] }, { status: 409 });
  const surfaces = await resolveSurfaceCommands(loaded, command, { dryRun, workspaceId: user.workspaceId });
  if (!surfaces.ok) return Response.json({ ok: false, message: surfaces.message, changes: [] }, { status: surfaces.status });
  if (surfaces.command === null) return Response.json({ ok: true, dryRun, revision: loaded.revision, changes: [], warning: null, opening: loaded.timeline.opening ?? null, timeline: loaded.timeline, surfaces: surfaces.reports });
  command = surfaces.command;
  const outcome = await applyReelCommand(user, loaded, command, revision, { dryRun });
  if (!outcome.ok) return Response.json({ ok: false, message: outcome.message, changes: outcome.result?.changes ?? [] }, { status: outcome.status });
  const { timeline, changes, warning } = outcome.result;
  return Response.json({ ok: true, dryRun, revision: outcome.revision, changes, warning: warning ?? null, opening: timeline.opening ?? null, timeline, ...(surfaces.reports.length ? { surfaces: surfaces.reports } : {}) });
}
