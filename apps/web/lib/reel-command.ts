import { applyCommand, hasSpeech, referencedAssetIds, timelineWithGrid, type BrandKit, type Command, type FaceInput, type CommandResult, type HookInputs, type Timeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { workspaceBrandKit } from "./brand-kit";
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

export type LoadedReel = { id: string; title: string; revision: number; timeline: Timeline; library: Record<string, LibraryAsset>; /** The workspace's brand kit (ADR 0078), for `applyTextStyle`; null when it has none. */ brandKit: BrandKit | null };

/** The reel and the library entries its clips and music use, in this workspace. */
export async function loadReel(user: { workspaceId: string }, id: string): Promise<LoadedReel | null> {
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true, title: true, revision: true, timeline: true } });
  if (!reel) return null;
  const timeline = readTimeline(reel.timeline);
  const ids = referencedAssetIds(timeline);
  const rows = ids.length ? await prisma.mediaAsset.findMany({ where: { id: { in: ids }, ...mediaScope(user.workspaceId) } }) : [];
  const library = Object.fromEntries((await toLibraryAssets(rows)).map((asset) => [asset.id, asset]));
  return { id: reel.id, title: reel.title, revision: reel.revision, timeline: onSongGrid(timeline, library), library, brandKit: await workspaceBrandKit(user.workspaceId) };
}

/**
 * The reel's music on its song's measured grid (ADR 0066): the asset row
 * mirrors the stored analysis, so a command like `snapToBeat` or `pace` sent
 * by an agent works from the beats the audio trace reports, not from a tempo
 * stored before a corrected analysis. The same timeline comes back when the
 * grid already matches or the song has not been measured.
 */
function onSongGrid(timeline: Timeline, library: Record<string, LibraryAsset>): Timeline {
  const song = timeline.music ? library[timeline.music.assetId] : undefined;
  if (!song) return timeline;
  return timelineWithGrid(timeline, { bpm: song.bpm, beatOffsetMs: song.beatOffsetMs, ...(song.songMap ? { downbeats: song.songMap.downbeats, sections: song.songMap.sections } : {}) });
}

/** What the planner can learn from the library alone: source lengths and the words of every transcribed video. */
export function hookInputsFromLibrary(library: Record<string, LibraryAsset>): Pick<HookInputs, "sourceDurationsMs" | "speech"> {
  const assets = Object.values(library);
  return {
    sourceDurationsMs: Object.fromEntries(assets.map((asset) => [asset.id, asset.durationMs])),
    speech: Object.fromEntries(assets.filter((asset) => asset.kind === "VIDEO" && hasSpeech(asset.transcript)).map((asset) => [asset.id, asset.transcript!.words])),
  };
}

/**
 * The presenter's face on each take the identity gate checked (ADR 0056), in source fractions with the take's size,
 * for the keyword lockup's placement (ADR 0089). Takes without a stored box are left out: the lockup then uses the
 * reference's place.
 */
export function facesFromLibrary(library: Record<string, LibraryAsset>): Record<string, FaceInput> {
  return Object.fromEntries(Object.values(library).flatMap((asset) => {
    const box = asset.face?.box;
    return box && asset.width && asset.height ? [[asset.id, { ...box, width: asset.width, height: asset.height }]] : [];
  }));
}

/** Commands that read the clips' speech from the library when an agent does not send it. */
const SPEECH_COMMANDS = new Set(["syncTextToSpeech", "composeKeywordLockup"]);

/** A hook command sent without measurements gets the library's: an agent need not read transcripts itself. */
export function withLibraryInputs(command: Command, library: Record<string, LibraryAsset>): Command {
  // A title timed to speech (ADR 0084) gets the same transcripts, alone or inside a batch.
  if (command.type === "syncTextToSpeech") return { ...command, speech: command.speech ?? hookInputsFromLibrary(library).speech };
  // A keyword lockup (ADR 0089) also gets where the presenter's face is.
  if (command.type === "composeKeywordLockup") return { ...command, speech: command.speech ?? hookInputsFromLibrary(library).speech, faces: command.faces ?? facesFromLibrary(library) };
  if (command.type === "batch" && command.commands.some((item) => SPEECH_COMMANDS.has(item.type))) {
    return { ...command, commands: command.commands.map((item) => (SPEECH_COMMANDS.has(item.type) ? withLibraryInputs(item, library) as typeof item : item)) };
  }
  if (command.type !== "hook") return command;
  const known = hookInputsFromLibrary(library);
  return { ...command, speech: command.speech ?? known.speech, sourceDurationsMs: command.sourceDurationsMs ?? known.sourceDurationsMs };
}

export type ApplyOutcome =
  | { ok: true; revision: number; result: CommandResult }
  | { ok: false; status: 400 | 409 | 404; message: string; result?: CommandResult };

/**
 * Applies one command to the saved reel and saves it, if the reel is still at `revision` (the reel's current one when omitted).
 * `dryRun` (ADR 0067) answers with the result and saves nothing, so an agent can ask `matchCuts` for its suggestion first.
 */
export async function applyReelCommand(user: { workspaceId: string }, loaded: LoadedReel, command: Command, revision = loaded.revision, options: { dryRun?: boolean } = {}): Promise<ApplyOutcome> {
  if (revision !== loaded.revision) return { ok: false, status: 409, message: "The reel changed since you read it. Read it again and send the command against its current revision." };
  const full = withLibraryInputs(command, loaded.library);
  const result = applyCommand(loaded.timeline, full, { generation: loaded.revision, sourceDurationsMs: hookInputsFromLibrary(loaded.library).sourceDurationsMs, brandKit: loaded.brandKit });
  if (result.rejected) return { ok: false, status: 400, message: result.rejected, result };
  if (result.stale) return { ok: false, status: 409, message: "The proposal was made against an older revision of the reel.", result };
  if (options.dryRun || result.changes.length === 0) return { ok: true, revision: loaded.revision, result };
  const saved = await saveReelFor(user, { id: loaded.id, revision: loaded.revision, timeline: result.timeline });
  if (!saved.ok) return { ok: false, status: saved.reason === "conflict" ? 409 : saved.reason === "missing" ? 404 : 400, message: saved.message, result };
  return { ok: true, revision: saved.revision, result };
}
