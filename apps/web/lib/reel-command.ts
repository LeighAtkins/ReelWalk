import { applyCommand, hasSpeech, referencedAssetIds, type Command, type CommandResult, type HookInputs, type Timeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { toLibraryAssets, type LibraryAsset } from "./library";
import { readTimeline } from "./reels";
import { saveReelFor } from "./save-reel";
import { mediaScope } from "./workspace";

/**
 * Document commands over HTTP (ADR 0068, on ADR 0048's command boundary):
 * agents build the owner's reels through `/api/...`, and until now the only
 * way to change a cut was to save a whole timeline. `applyReelCommand` runs
 * one command against the saved reel with the same pure `applyCommand` the
 * editor uses, and saves the result at the reel's revision, so a tab that
 * saved in between wins and the agent is told to read the reel again.
 */

export type LoadedReel = { id: string; title: string; revision: number; timeline: Timeline; library: Record<string, LibraryAsset> };

/** The reel and the library entries its clips and music use, in this workspace. */
export async function loadReel(user: { workspaceId: string }, id: string): Promise<LoadedReel | null> {
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true, revision: true, timeline: true } });
  if (!reel) return null;
  const timeline = readTimeline(reel.timeline);
  const ids = referencedAssetIds(timeline);
  const rows = ids.length ? await prisma.mediaAsset.findMany({ where: { id: { in: ids }, ...mediaScope(user.workspaceId) } }) : [];
  const library = Object.fromEntries((await toLibraryAssets(rows)).map((asset) => [asset.id, asset]));
  return { id: reel.id, title: reel.title, revision: reel.revision, timeline, library };
}

/** What the planner can learn from the library alone: source lengths and the words of every transcribed video. */
export function hookInputsFromLibrary(library: Record<string, LibraryAsset>): Pick<HookInputs, "sourceDurationsMs" | "speech"> {
  const assets = Object.values(library);
  return {
    sourceDurationsMs: Object.fromEntries(assets.map((asset) => [asset.id, asset.durationMs])),
    speech: Object.fromEntries(assets.filter((asset) => asset.kind === "VIDEO" && hasSpeech(asset.transcript)).map((asset) => [asset.id, asset.transcript!.words])),
  };
}

/** A hook command sent without measurements gets the library's: an agent need not read transcripts itself. */
export function withLibraryInputs(command: Command, library: Record<string, LibraryAsset>): Command {
  if (command.type !== "hook") return command;
  const known = hookInputsFromLibrary(library);
  return { ...command, speech: command.speech ?? known.speech, sourceDurationsMs: command.sourceDurationsMs ?? known.sourceDurationsMs };
}

export type ApplyOutcome =
  | { ok: true; revision: number; result: CommandResult }
  | { ok: false; status: 400 | 409 | 404; message: string; result?: CommandResult };

/** Applies one command to the saved reel and saves it, if the reel is still at `revision` (the reel's current one when omitted). */
export async function applyReelCommand(user: { workspaceId: string }, loaded: LoadedReel, command: Command, revision = loaded.revision): Promise<ApplyOutcome> {
  if (revision !== loaded.revision) return { ok: false, status: 409, message: "The reel changed since you read it. Read it again and send the command against its current revision." };
  const full = withLibraryInputs(command, loaded.library);
  const result = applyCommand(loaded.timeline, full, { generation: loaded.revision, sourceDurationsMs: hookInputsFromLibrary(loaded.library).sourceDurationsMs });
  if (result.rejected) return { ok: false, status: 400, message: result.rejected, result };
  if (result.stale) return { ok: false, status: 409, message: "The proposal was made against an older revision of the reel.", result };
  if (result.changes.length === 0) return { ok: true, revision: loaded.revision, result };
  const saved = await saveReelFor(user, { id: loaded.id, revision: loaded.revision, timeline: result.timeline });
  if (!saved.ok) return { ok: false, status: saved.reason === "conflict" ? 409 : saved.reason === "missing" ? 404 : 400, message: saved.message, result };
  return { ok: true, revision: saved.revision, result };
}
