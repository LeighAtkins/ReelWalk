import type { BatchableCommand, Command } from "@reelwalk/core";
import { getSessionUser } from "@/lib/auth";
import { applyReelCommand, loadReel } from "@/lib/reel-command";

export const dynamic = "force-dynamic";

/** Every command the editor's document store accepts (ADR 0048, 0059, 0060, 0062, 0064, 0067, 0068). */
const COMMAND_TYPES = new Set<Command["type"]>([
  "trimClip", "moveClip", "splitClip", "deleteClip", "duplicateClip", "setSpeed", "setMusic", "snapToBeat", "pace", "setOnBeat",
  "retime", "retimeToLength", "insertPresenterTakes", "applyFinish", "hook", "applyProposal", "updateText", "addText", "batch",
  "setRamp", "setCamera", "matchCuts", "setTransition",
]);

/** Commands an agent may send in one request; more is a sign of a loop. */
const MAX_COMMANDS = 50;

const isCommand = (item: unknown): item is Command =>
  typeof item === "object" && item !== null && typeof (item as { type?: unknown }).type === "string" && COMMAND_TYPES.has((item as Command).type);
const inBatch = (command: Command): command is BatchableCommand => command.type !== "batch" && command.type !== "applyProposal";

const SHAPE = `Send { command: { type, ... } } or { commands: [{ type, ... }] }; type is one of ${[...COMMAND_TYPES].join(", ")}.`;

/**
 * Document commands against the saved reel, for the agents that build the
 * owner's reels (ADR 0067, ADR 0068, on ADR 0048's command boundary):
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
  const outcome = await applyReelCommand(user, loaded, command, revision, { dryRun });
  if (!outcome.ok) return Response.json({ ok: false, message: outcome.message, changes: outcome.result?.changes ?? [] }, { status: outcome.status });
  const { timeline, changes, warning } = outcome.result;
  return Response.json({ ok: true, dryRun, revision: outcome.revision, changes, warning: warning ?? null, opening: timeline.opening ?? null, timeline });
}
