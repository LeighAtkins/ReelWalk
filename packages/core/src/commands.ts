/**
 * The editor's document commands (ADR 0048). Every change to the cut, from
 * whatever button it comes (a trim handle, the beat snap, picking a song, an
 * AI edit, the draft review), is one command applied by one pure function,
 * so it moves titles the same way and lands as one undo step.
 *
 * Async proposals (Ask, Make it for me, the Opus director) are computed
 * against a document generation: a number the editor bumps on every change.
 * `applyProposal` only replaces the reel when the generation it was computed
 * against is still the current one; otherwise it reports `stale` and the
 * editor asks the studio to review the reel rather than silently replacing
 * what they did in the meantime.
 */
import { snapCutsToBeats } from "./beats";
import { resolveTextStyle, type BrandKit } from "./brand-kit";
import { applyMove, type MoveId } from "./moves";
import { cameraPreset, CAMERA_PRESETS, type Camera, type CameraPreset } from "./camera";
import { placeDropOnCut } from "./drop";
import { suggestMatchCuts, type ClipMotion } from "./match-cut";
import { paceTimeline, putOnTheBeat } from "./pacing";
import { rampPreset, RAMP_PRESETS, type Ramp, type RampPreset } from "./ramp";
import { motionReadSchema } from "./motion-kind";
import { autoPlaceSfx, trimSfxToReel, withSfx, type AutoSfxOptions } from "./sfx";
import type { SongMap } from "./song";
import { applyFinish, type FinishId } from "./finishes";
import { planHook, stripHook, type HookInputs } from "./hook";
import { retime, retimeToLength } from "./review";
import { insertPresenterTakes, type PresenterTakeInsert } from "./script";
import { planCutaways, type CutawayOptions } from "./cutaways";
import { matchLook, type ColorStats } from "./look";
import { attachedAnchors, retimeTexts } from "./text-timing";
import { placementProblem, surfacePatch, type SurfacePick, type TitleOnSurface } from "./surface-place";
import { speechSync } from "./wall-text";
import type { TranscriptWord } from "./transcript";
import {
  clipDurationMs,
  duplicateClip,
  locate,
  moveClip,
  parseTimeline,
  removeClip,
  setMusic,
  splitAt,
  trimClip,
  updateClip,
  addText,
  updateText,
  timelineSchema,
  RETIRED_TRANSITIONS,
  TRANSITIONS,
  endCardSchema,
  type EndCard,
  type ClipSettings,
  type HookPattern,
  type Music,
  type SfxClip,
  type TextOverlay,
  type Timeline,
} from "./timeline";


/** A song for `setMusic`; without a volume it keeps the current song's (or 0.8). */
export type MusicChoice = Omit<Music, "volume"> & { volume?: number };

export type Command =
  /** A clip's source window (the trim handles, the Trim sheet). */
  | { type: "trimClip"; clipId: string; window: { sourceStartMs: number; sourceEndMs: number } }
  /** A clip moved to another place in the order. */
  | { type: "moveClip"; clipId: string; toIndex: number }
  /** The clip under `atMs` cut in two; the second piece gets `newId`. */
  | { type: "splitClip"; atMs: number; newId: string }
  | { type: "deleteClip"; clipId: string }
  | { type: "duplicateClip"; clipId: string; newId: string }
  | { type: "setSpeed"; clipId: string; speed: number }
  /** A song (or none), with the cuts moved onto its beat in the same step when `snap` is set and it has a tempo. */
  | { type: "setMusic"; music: MusicChoice | null; snap?: boolean }
  /** The cuts moved onto the current song's beat. */
  | { type: "snapToBeat" }
  /**
   * The cut moved to the song (ADR 0059) at `energy` (0 chill to 1 hype),
   * from the reel before the Energy gesture began, so dragging back gives
   * back the same cut. `clipEnergy` is measured motion by clip id; `songMap`
   * is the song's bars and sections when the song did not have them yet.
   */
  | { type: "pace"; energy: number; clipEnergy?: Record<string, number>; songMap?: SongMap; /** Assets whose clips carry speech: their clips are held (see `heldByPace`). */ speechAssetIds?: string[]; /** Ramp the shots in the build and the drop into their cuts (ADR 0067), so beat-cuts land on the fast part. */ ramps?: boolean }
  /** "On the beat" (ADR 0059) switched; switching it on puts entrances, bursts and the pass on the bar. */
  | { type: "setOnBeat"; on: boolean; speechAssetIds?: string[] }
  /** The draft review's pace and length (ADR 0022). */
  | { type: "retime"; shotMs: number }
  | { type: "retimeToLength"; totalMs: number }
  /** A script's finished presenter takes (ADR 0060), all placed in one step. */
  | { type: "insertPresenterTakes"; takes: PresenterTakeInsert[] }
  /** Cutaways to the reel's own b-roll every `everyMs` of each presenter take, her voice continuing (ADR 0069); null removes them. */
  | { type: "cutaways"; everyMs: number | null; holdMs?: number; clipIds?: string[] }
  /** "Make it pop" / "Make it premium" (ADR 0064): music mood, type, pace and look in one step; `music` is the song it picked, if any. */
  | { type: "applyFinish"; finish: FinishId; music?: MusicChoice | null; /** Assets whose clips carry speech: those clips are held (`heldByFinish`). */ speechAssetIds?: string[]; clipEnergy?: Record<string, number>; songMap?: SongMap }
  /**
   * The opening cut to a hook pattern (ADR 0068): the first 1.5–3 s rewritten
   * (a clip moved to the front and started mid-move or on the first word, a
   * 0.6 s interrupt, the hook title and promise), titles retimed by the
   * attachment rule. `pattern: null` takes an earlier plan's texts and
   * interrupt out. One undo step either way.
   */
  | ({ type: "hook"; pattern: HookPattern | null } & HookInputs)
  /**
   * A whole timeline computed elsewhere (an AI edit, the autopilot, the
   * director) against `baseGeneration`. Applied only when that is still the
   * current generation. A song the proposal chose is set (and snapped to) in
   * the same step, so the edit and its music are one undo.
   */
  | { type: "applyProposal"; baseGeneration: number; proposal: unknown; music?: MusicChoice & { snap?: boolean } }
  /** A clip's speed ramp (ADR 0067): a preset's name, a curve, or null for constant speed. The clip's length does not change, so nothing is retimed. */
  | { type: "setRamp"; clipId: string; ramp: Ramp | RampPreset | null }
  /** A clip's eased camera move (ADR 0067): a preset's name, keys, or null to go back to its `motion`. */
  | { type: "setCamera"; clipId: string; camera: Camera | CameraPreset | null }
  /**
   * A named camera move from the moves table (ADR 0076) written onto a clip: its eased camera, speed ramp and the zoom or
   * streak blur on the cut in or out. One undo step. An AI-only move (a dolly zoom, an orbit) is refused with the reason;
   * ask for it as an AI shot with `move` on POST /api/ai/generations instead.
   */
  | { type: "applyMove"; clipId: string; move: MoveId }
  /**
   * Match cuts (ADR 0067) from measured motion by clip id: `reorder` (the default) puts the clips in the suggested chain
   * (held clips keep their slots). The whip directions and speed-ramp footage it also wrote went with those kinds (ADR 0082).
   */
  | { type: "matchCuts"; motion: Record<string, ClipMotion>; reorder?: boolean; heldClipIds?: string[] }
  /**
   * One clip's transition in (ADR 0082): "cut" (no transition), "fade" (a crossfade), "softDissolve", "focusPull",
   * "lightLeak", or "walk" between two 360 photos. The retired whip and speed ramp are refused with that reason.
   */
  | { type: "setTransition"; clipId: string; transition: Timeline["clips"][number]["transitionIn"] }
  /** One title's look or place (the critic's fixes, ADR 0062). Does not change the cut, so nothing is retimed. */
  | { type: "updateText"; textId: string; patch: Partial<Omit<TextOverlay, "id">> }
  /**
   * A title put on a surface of the picture (ADR 0075): its corners, the surface blend, the house serif, the ink and (when it
   * could be followed) the track, in one step and one undo. `atMs` is the reel time of the frame that was looked at and
   * `clipId` the shot it is in; `pick` which kind of surface to take ("auto": the best). The surface is found from the picture,
   * which this pure command cannot do: the HTTP commands route (and the editor's sheet) find it and send it as `placement`;
   * without one the command is refused with that explanation.
   */
  | { type: "placeOnSurface"; textId: string; clipId?: string; atMs?: number; pick?: SurfacePick; placement?: TitleOnSurface;
    /**
     * Where on the surface and how big (ADR 0084), used when the route finds the surface: the line centred on the frame
     * point `at` (on the surface) with capitals `capHeight` of the frame tall (default 0.025), in the surface's
     * perspective. Absent: as large as the surface comfortably takes, centred (ADR 0075).
     */
    fit?: { at: { x: number; y: number }; capHeight?: number } }
  /**
   * A title timed to the words it repeats (ADR 0084): its words found in what the clip under it (or `clipId`) says, the
   * title starting with the first word and ending `holdMs` after the last (default 700, never past the shot), each word
   * arriving as it is said ("words" reveal with `wordsMs`). `speech` is the word-timed transcripts by asset id; the HTTP
   * commands route fills it from the library, so an agent sends only `textId`. Refused, with what the clip says, when the
   * words are not heard there.
   */
  | { type: "syncTextToSpeech"; textId: string; clipId?: string; holdMs?: number; leadMs?: number; speech?: Record<string, readonly TranscriptWord[]> }
  /**
   * A brand kit style applied to a title by name (ADR 0078): the kit's font, weight, slant, hard shadow and plate, with its
   * colour, size and tracking, written onto the text in one step. Checked against the workspace's kit: no kit, or a name the
   * kit does not have, is refused with the names it does have. `style: null` takes the kit style off (the text keeps the colour,
   * size and spacing it has). Use `dryRun` on the route to see the result first.
   */
  | { type: "applyTextStyle"; textId: string; style: string | null }
  /** One clip's look (a camera move, zoom, grade, fit, transition; the retention critic's fixes, ADR 0071). Not its timing: `setSpeed` and `trimClip` change the cut. */
  | { type: "updateClip"; clipId: string; patch: Omit<ClipSettings, "speed"> }
  /**
   * One coherent look (ADR 0070): every clip's colour matched to the reference clip's. `stats` are measured
   * statistics by clip id, written onto the clips; clips already carrying statistics keep theirs. `referenceClipId`
   * null clears the match. Changes no cut, so nothing is retimed.
   */
  | { type: "matchLook"; referenceClipId?: string | null; strength?: number; stats?: Record<string, ColorStats> }
  /** A new title. */
  | { type: "addText"; text: Omit<TextOverlay, "endMs" | "animation"> & { endMs?: number; animation?: TextOverlay["animation"] } }
  /** Sound design placed by the rule (ADR 0066): whooshes on quick cuts when asked, a riser and impact into the reveal, ambience by tag. Replaces what it placed before, keeps hand-placed sounds. */
  | { type: "autoSfx"; options?: AutoSfxOptions }
  /** The whole `sfx` track set by hand (an agent, a sheet); an empty list removes it. */
  | { type: "setSfx"; sfx: SfxClip[] }
  /** The song's drop put on cut `cut` (1 = the start of the second clip): your own song is moved, an Instagram sound's cut is (ADR 0066). */
  | { type: "dropOnCut"; cut: number; dropSongMs: number }
  /**
   * The closing card (ADR 0065) and how it arrives (ADR 0082: "fade", "cut", "over", "leak"); null takes it off. It is
   * drawn over the last `durationMs` of the reel, so nothing is retimed.
   */
  | { type: "setEndCard"; endCard: EndCard | null }
  /** Several commands as one step and one undo ("Fix all", ADR 0062): all of them land, or none. */
  | { type: "batch"; commands: BatchableCommand[] };

/** Commands a batch may hold: no proposals (they carry their own generation check) and no nested batches. */
export type BatchableCommand = Exclude<Command, { type: "applyProposal" } | { type: "batch" }>;

/**
 * Every command type, as one record over `Command["type"]`: a member added to
 * `Command` and not listed here does not compile. The HTTP commands route
 * (ADR 0068) accepts exactly this list, so a new document command is reachable
 * by the agents that build reels over HTTP the moment it exists, instead of
 * being left off a hand-kept copy (as `cutaways` was, ADR 0069).
 */
const COMMAND_TYPE_REGISTRY: Record<Command["type"], true> = {
  trimClip: true, moveClip: true, splitClip: true, deleteClip: true, duplicateClip: true, setSpeed: true, setMusic: true, snapToBeat: true, pace: true, setOnBeat: true,
  retime: true, retimeToLength: true, insertPresenterTakes: true, cutaways: true, applyFinish: true, hook: true, applyProposal: true,
  setRamp: true, setCamera: true, applyMove: true, matchCuts: true, setTransition: true, updateText: true, placeOnSurface: true, syncTextToSpeech: true, applyTextStyle: true, updateClip: true, matchLook: true, addText: true,
  autoSfx: true, setSfx: true, dropOnCut: true, setEndCard: true, batch: true,
};
/** The type of every command, in registry order. */
export const COMMAND_TYPES = Object.keys(COMMAND_TYPE_REGISTRY) as Command["type"][];

export type CommandContext = {
  /** The generation of the timeline the command is applied to. */
  generation: number;
  /** Source lengths by asset id: trims and beat snaps never run past a video's end. */
  sourceDurationsMs?: Record<string, number | null | undefined>;
  /**
   * The timeline before the gesture this command continues (a trim handle
   * dragged in and back out): texts are anchored there, not to the previous
   * step, so a title squeezed by the drag comes back when the drag undoes it.
   */
  gestureBase?: Timeline;
  /** The workspace's brand kit (ADR 0078), for `applyTextStyle`. Absent: the workspace has none. */
  brandKit?: BrandKit | null;
};

export type Change = { kind: "clip"; id: string } | { kind: "text"; id: string } | { kind: "music" } | { kind: "other"; key: string };

export type CommandResult = {
  timeline: Timeline;
  /** What changed, clip by clip and text by text (empty when nothing did). */
  changes: Change[];
  /** Set when a proposal was computed against an older generation; `timeline` is then the current one, untouched. */
  stale?: true;
  /** Set when the command could not be applied (it threw, or its result is not a valid timeline); `timeline` is the current one, untouched. */
  rejected?: string;
  /** Set when the result is not a valid timeline but the reel already was not before it: the command is let through so the reel stays editable. */
  warning?: string;
};

/** Applies one command. Pure: the same timeline and command always give the same result. */
export function applyCommand(timeline: Timeline, command: Command, context: CommandContext): CommandResult {
  if (command.type === "applyProposal" && command.baseGeneration !== context.generation) return { timeline, changes: [], stale: true };
  let next: Timeline;
  try {
    next = run(timeline, command, context);
  } catch (error) {
    return { timeline, changes: [], rejected: error instanceof Error ? error.message : String(error) };
  }
  if (next === timeline) return { timeline, changes: [] };
  // Nothing invalid enters the history: the result must still be a timeline the schema accepts.
  const check = timelineSchema.safeParse(next);
  const problem = check.success ? null : check.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  if (problem && !check.success) {
    // A reel that was already invalid (saved before a limit, or changed outside the commands) stays editable,
    // but only by commands that add no problem it did not already have.
    const issueKey = (issue: { path: PropertyKey[]; code: string }) => `${issue.path.map(String).join(".")}|${issue.code}`;
    const was = timelineSchema.safeParse(timeline);
    const old = new Set(was.success ? [] : was.error.issues.map(issueKey));
    const fresh = check.error.issues.filter((issue) => !old.has(issueKey(issue)));
    if (fresh.length > 0) return { timeline, changes: [], rejected: fresh.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  }
  const changes = diffTimelines(timeline, next);
  // A command that changed nothing (a clip moved to where it is) is no step at all.
  if (changes.length === 0) return { timeline, changes };
  return problem ? { timeline: next, changes, warning: problem } : { timeline: next, changes };
}

function run(timeline: Timeline, command: Command, context: CommandContext): Timeline {
  const durations = context.sourceDurationsMs ?? {};
  const sourceOf = (clipId: string) => {
    const clip = timeline.clips.find((item) => item.id === clipId);
    return clip ? (durations[clip.assetId] ?? undefined) : undefined;
  };
  // Every cut change goes through retimeTexts, against the timeline it started from.
  const cut = (after: Timeline, options?: Parameters<typeof retimeTexts>[2]) => (after === timeline ? timeline : retimeTexts(context.gestureBase ?? timeline, after, options));

  switch (command.type) {
    case "trimClip":
      return cut(trimClip(timeline, command.clipId, command.window, sourceOf(command.clipId)));
    case "moveClip":
      return cut(moveClip(timeline, command.clipId, command.toIndex));
    case "splitClip": {
      const after = splitAt(timeline, command.atMs, command.newId);
      if (after === timeline) return timeline;
      // Texts over the second half now belong to the new piece: same picture, offset from its start.
      const at = locate(timeline, command.atMs)!;
      const piece = timeline.clips[at.index];
      const firstMs = clipDurationMs(after.clips[at.index]);
      const anchors = attachedAnchors(timeline).map((anchor) =>
        anchor.clipId === piece.id && anchor.offsetMs >= firstMs
          ? { ...anchor, clipId: command.newId, clipIndex: anchor.clipIndex + 1, offsetMs: anchor.offsetMs - firstMs }
          : anchor,
      );
      return cut(after, { anchors });
    }
    case "deleteClip":
      return cut(removeClip(timeline, command.clipId));
    case "duplicateClip":
      return cut(duplicateClip(timeline, command.clipId, command.newId));
    case "setSpeed":
      return cut(updateClip(timeline, command.clipId, { speed: command.speed }));
    case "setMusic":
      return withMusic(timeline, command.music, Boolean(command.snap), durations, true);
    case "snapToBeat": {
      if (timeline.clips.length < 2) return timeline;
      const snapped = cut(snapCutsToBeats(timeline, durations));
      return timeline.music?.onBeat ? putOnTheBeat(snapped) : snapped;
    }
    case "pace": {
      const base = context.gestureBase ?? timeline;
      if (!base.music?.bpm) return timeline;
      const map = command.songMap && !base.music.downbeats?.length ? { downbeats: command.songMap.downbeats, sections: command.songMap.sections } : {};
      const energy = Math.round(Math.min(1, Math.max(0, command.energy)) * 100) / 100;
      // "Ramp into cuts" is remembered on the music; switching it off takes back the ramps pacing gave (the preset it uses).
      const ramps = command.ramps ?? base.music.ramps ?? false;
      const clips = command.ramps === false ? base.clips.map((clip) => (clip.ramp?.preset === "into-cut" ? { ...clip, ramp: null } : clip)) : base.clips;
      const withSong: Timeline = { ...base, clips, music: { ...base.music, ...map, energy, ...(command.ramps !== undefined ? { ramps: command.ramps } : {}) } };
      return paceTimeline(withSong, { energy, clipEnergy: command.clipEnergy, speechAssetIds: command.speechAssetIds, sourceDurationsMs: durations, ramps });
    }
    case "setOnBeat": {
      if (!timeline.music) return timeline;
      const next: Timeline = { ...timeline, music: { ...timeline.music, onBeat: command.on } };
      return command.on ? putOnTheBeat(next) : next;
    }
    case "retime":
      return retime(timeline, command.shotMs, durations);
    case "retimeToLength":
      return retimeToLength(timeline, command.totalMs, durations);
    case "insertPresenterTakes":
      return cut(insertPresenterTakes(timeline, command.takes));
    case "cutaways": {
      const options: CutawayOptions = { everyMs: command.everyMs, holdMs: command.holdMs, clipIds: command.clipIds };
      return cut(planCutaways(timeline, options));
    }
    case "applyFinish":
      return applyFinish(timeline, command.finish, { music: command.music, sourceDurationsMs: durations, speechAssetIds: command.speechAssetIds, clipEnergy: command.clipEnergy, songMap: command.songMap });
    case "hook": {
      if (command.pattern === null) return stripHook(timeline);
      const { type: _type, pattern, ...inputs } = command;
      void _type;
      const plan = planHook(timeline, pattern, { ...inputs, sourceDurationsMs: inputs.sourceDurationsMs ?? durations });
      if (!plan) throw new Error(`The ${pattern} opening cannot be made from this reel.`);
      return plan.timeline;
    }
    case "applyProposal": {
      // The proposal already placed its texts (through retimeTexts, in applyAiEditPlan); it is taken as it is.
      const proposal = parseTimeline(command.proposal);
      if (!command.music) return proposal;
      const { snap, ...music } = command.music;
      // The proposal placed its own titles: its song's cuts are snapped, but nothing is moved onto the bar.
      return withMusic(proposal, music, Boolean(snap), durations, false);
    }
    // The three throw for a clip that is not there, so a batch holding them is all or nothing (as updateText does).
    case "setRamp": {
      requireClip(timeline, command.clipId);
      const ramp = typeof command.ramp === "string" ? (RAMP_PRESETS.includes(command.ramp) ? rampPreset(command.ramp) : null) : command.ramp;
      if (typeof command.ramp === "string" && !ramp) throw new Error(`There is no ramp called ${command.ramp}.`);
      return updateClip(timeline, command.clipId, { ramp });
    }
    case "setCamera": {
      requireClip(timeline, command.clipId);
      const camera = typeof command.camera === "string" ? (CAMERA_PRESETS.includes(command.camera) ? cameraPreset(command.camera) : null) : command.camera;
      if (typeof command.camera === "string" && !camera) throw new Error(`There is no camera move called ${command.camera}.`);
      return updateClip(timeline, command.clipId, { camera });
    }
    case "applyMove":
      return applyMove(timeline, command.clipId, command.move);
    case "setTransition": {
      requireClip(timeline, command.clipId);
      const name = command.transition as string;
      if ((RETIRED_TRANSITIONS as readonly string[]).includes(name)) throw new Error(`The ${name} transition was retired (ADR 0082). Use one of: ${TRANSITIONS.join(", ")}.`);
      if (!(TRANSITIONS as readonly string[]).includes(name)) throw new Error(`There is no transition called ${name}. Use one of: ${TRANSITIONS.join(", ")}.`);
      return updateClip(timeline, command.clipId, { transitionIn: command.transition });
    }
    case "matchCuts": {
      // A malformed reading of the camera is refused rather than guessed at.
      for (const [id, measured] of Object.entries(command.motion)) {
        for (const key of ["startRead", "endRead"] as const) {
          if (measured?.[key] !== undefined && !motionReadSchema.safeParse(measured[key]).success) throw new Error(`The ${key} of the motion for ${id} is not a camera reading (kind, speed, tx, ty, zoom, rotate, focus, confidence).`);
        }
      }
      const options = { heldClipIds: command.heldClipIds };
      const suggestions = suggestMatchCuts(timeline, command.motion, options);
      let next = timeline;
      if (command.reorder !== false && suggestions.order.length === timeline.clips.length) {
        const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
        const clips = suggestions.order.map((id) => byId.get(id)!);
        if (clips.some((clip, index) => clip !== timeline.clips[index])) next = cut({ ...timeline, clips });
      }
      return next;
    }
    // Both throw rather than quietly changing nothing, so a batch holding them is all or nothing.
    case "setEndCard": {
      if (command.endCard === null) {
        const rest = { ...timeline };
        delete rest.endCard;
        return rest;
      }
      const parsed = endCardSchema.safeParse(command.endCard);
      if (!parsed.success) throw new Error(`That end card is not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}.`);
      return { ...timeline, endCard: parsed.data };
    }
    case "updateText":
      if (!timeline.texts.some((text) => text.id === command.textId)) throw new Error(`There is no text called ${command.textId} in the reel.`);
      return updateText(timeline, command.textId, command.patch);
    case "placeOnSurface": {
      if (!timeline.texts.some((text) => text.id === command.textId)) throw new Error(`There is no text called ${command.textId} in the reel.`);
      if (!command.placement) throw new Error("placeOnSurface needs a surface: send it to POST /api/reels/:id/commands with clipId and atMs and the app finds one in the picture, or pass placement.corners yourself.");
      const problem = placementProblem(command.placement);
      if (problem) throw new Error(problem);
      return updateText(timeline, command.textId, surfacePatch(command.placement));
    }
    case "syncTextToSpeech": {
      if (!command.speech) throw new Error("syncTextToSpeech needs the clips' transcripts: send it to POST /api/reels/:id/commands, which reads them from the library, or pass speech yourself.");
      return updateText(timeline, command.textId, speechSync(timeline, command.textId, command.speech, command).patch);
    }
    case "applyTextStyle": {
      if (!timeline.texts.some((text) => text.id === command.textId)) throw new Error(`There is no text called ${command.textId} in the reel.`);
      if (command.style === null) return updateText(timeline, command.textId, { brand: undefined });
      if (!context.brandKit) throw new Error("This workspace has no brand kit, so there are no named text styles to apply. A kit is added to a workspace by its admin.");
      const resolved = resolveTextStyle(context.brandKit, command.style);
      if (!resolved.ok) throw new Error(resolved.message);
      return updateText(timeline, command.textId, resolved.patch);
    }
    case "updateClip": {
      if (!timeline.clips.some((clip) => clip.id === command.clipId)) throw new Error(`There is no clip called ${command.clipId} in the reel.`);
      // Speed is a cut change (it retimes everything after the clip), so it is not a setting this command may touch.
      const patch: ClipSettings = { ...(command.patch as ClipSettings) };
      delete patch.speed;
      return updateClip(timeline, command.clipId, patch);
    }
    case "addText": {
      if (timeline.texts.some((text) => text.id === command.text.id)) throw new Error(`A text called ${command.text.id} is already in the reel.`);
      const added = addText(timeline, command.text);
      if (added === timeline) throw new Error("There is no room in the reel for that text.");
      return added;
    }
    case "matchLook":
      return matchLook(timeline, command);
    case "autoSfx":
      return withSfx(timeline, autoPlaceSfx(timeline, command.options));
    case "setSfx":
      return withSfx(timeline, command.sfx);
    case "dropOnCut": {
      if (!timeline.music) throw new Error("The reel has no song to place a drop from.");
      if (command.cut < 1 || command.cut >= timeline.clips.length) throw new Error(`There is no cut ${command.cut}: the reel has ${Math.max(0, timeline.clips.length - 1)} cut(s).`);
      const placed = placeDropOnCut(timeline, command.cut, command.dropSongMs, durations);
      if (placed === timeline) throw new Error("The shots before that cut cannot be stretched or squeezed enough to put the drop on it.");
      return trimSfxToReel(cut(placed));
    }
    case "batch":
      // Each step runs against the result of the one before; a failing step throws, so the whole batch is rejected.
      return command.commands.reduce((current, step) => run(current, step, { ...context, gestureBase: undefined }), timeline);
    default:
      // A command this build does not know (an agent's typo over HTTP, ADR 0067) is refused, never let through as "nothing changed".
      throw new Error(`There is no command called ${String((command as { type?: unknown }).type)}.`);
  }
}


function requireClip(timeline: Timeline, clipId: string): void {
  if (!timeline.clips.some((clip) => clip.id === clipId)) throw new Error(`There is no clip called ${clipId} in the reel.`);
}

function withMusic(timeline: Timeline, choice: MusicChoice | null, snap: boolean, durations: Record<string, number | null | undefined>, onBeat: boolean): Timeline {
  // "On the beat" is on for every song chosen from now on, unless the reel's song had it switched off (ADR 0059).
  const withSong = setMusic(timeline, choice ? { ...choice, volume: choice.volume ?? timeline.music?.volume ?? 0.8, onBeat: choice.onBeat ?? timeline.music?.onBeat ?? true } : null);
  if (!snap || !withSong.music?.bpm || withSong.clips.length < 2) return withSong;
  const snapped = retimeTexts(timeline, snapCutsToBeats(withSong, durations));
  return onBeat && snapped.music?.onBeat ? putOnTheBeat(snapped) : snapped;
}

/** Which clips, texts and other parts differ between two timelines. */
export function diffTimelines(before: Timeline, after: Timeline): Change[] {
  const changes: Change[] = [];
  const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item, index) => [item.id, { item, index }]));
  const clipsBefore = byId(before.clips);
  const clipsAfter = byId(after.clips);
  for (const id of new Set([...clipsBefore.keys(), ...clipsAfter.keys()])) {
    const a = clipsBefore.get(id);
    const b = clipsAfter.get(id);
    if (!a || !b || a.index !== b.index || !same(a.item, b.item)) changes.push({ kind: "clip", id });
  }
  const textsBefore = byId(before.texts);
  const textsAfter = byId(after.texts);
  for (const id of new Set([...textsBefore.keys(), ...textsAfter.keys()])) {
    const a = textsBefore.get(id)?.item;
    const b = textsAfter.get(id)?.item;
    if (!a || !b || !same(a, b)) changes.push({ kind: "text", id });
  }
  if (!same(before.music, after.music)) changes.push({ kind: "music" });
  for (const key of ["plan", "details", "logo", "cover", "hook", "opening", "look", "sfx", "endCard"] as const) {
    if (!same(before[key], after[key])) changes.push({ kind: "other", key });
  }
  return changes;
}
