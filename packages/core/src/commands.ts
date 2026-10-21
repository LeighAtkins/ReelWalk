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
import { paceTimeline, putOnTheBeat } from "./pacing";
import type { SongMap } from "./song";
import { retime, retimeToLength } from "./review";
import { insertPresenterTakes, type PresenterTakeInsert } from "./script";
import { attachedAnchors, retimeTexts } from "./text-timing";
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
  timelineSchema,
  type Music,
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
  | { type: "pace"; energy: number; clipEnergy?: Record<string, number>; songMap?: SongMap }
  /** "On the beat" (ADR 0059) switched; switching it on puts entrances, bursts, whips and the pass on the bar. */
  | { type: "setOnBeat"; on: boolean }
  /** The draft review's pace and length (ADR 0022). */
  | { type: "retime"; shotMs: number }
  | { type: "retimeToLength"; totalMs: number }
  /** A script's finished presenter takes (ADR 0060), all placed in one step. */
  | { type: "insertPresenterTakes"; takes: PresenterTakeInsert[] }
  /**
   * A whole timeline computed elsewhere (an AI edit, the autopilot, the
   * director) against `baseGeneration`. Applied only when that is still the
   * current generation. A song the proposal chose is set (and snapped to) in
   * the same step, so the edit and its music are one undo.
   */
  | { type: "applyProposal"; baseGeneration: number; proposal: unknown; music?: MusicChoice & { snap?: boolean } };

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
      return withMusic(timeline, command.music, Boolean(command.snap), durations);
    case "snapToBeat": {
      if (timeline.clips.length < 2) return timeline;
      const snapped = cut(snapCutsToBeats(timeline, durations));
      return timeline.music?.onBeat ? putOnTheBeat(snapped, durations) : snapped;
    }
    case "pace": {
      const base = context.gestureBase ?? timeline;
      if (!base.music?.bpm) return timeline;
      const map = command.songMap && !base.music.downbeats?.length ? { downbeats: command.songMap.downbeats, sections: command.songMap.sections } : {};
      const energy = Math.round(Math.min(1, Math.max(0, command.energy)) * 100) / 100;
      const withSong: Timeline = { ...base, music: { ...base.music, ...map, energy } };
      return paceTimeline(withSong, { energy, clipEnergy: command.clipEnergy, sourceDurationsMs: durations });
    }
    case "setOnBeat": {
      if (!timeline.music) return timeline;
      const next: Timeline = { ...timeline, music: { ...timeline.music, onBeat: command.on } };
      return command.on ? putOnTheBeat(next, durations) : next;
    }
    case "retime":
      return retime(timeline, command.shotMs, durations);
    case "retimeToLength":
      return retimeToLength(timeline, command.totalMs, durations);
    case "insertPresenterTakes":
      return cut(insertPresenterTakes(timeline, command.takes));
    case "applyProposal": {
      // The proposal already placed its texts (through retimeTexts, in applyAiEditPlan); it is taken as it is.
      const proposal = parseTimeline(command.proposal);
      if (!command.music) return proposal;
      const { snap, ...music } = command.music;
      return withMusic(proposal, music, Boolean(snap), durations);
    }
  }
}

function withMusic(timeline: Timeline, choice: MusicChoice | null, snap: boolean, durations: Record<string, number | null | undefined>): Timeline {
  // "On the beat" is on for every song chosen from now on, unless the reel's song had it switched off (ADR 0059).
  const withSong = setMusic(timeline, choice ? { ...choice, volume: choice.volume ?? timeline.music?.volume ?? 0.8, onBeat: choice.onBeat ?? timeline.music?.onBeat ?? true } : null);
  if (!snap || !withSong.music?.bpm || withSong.clips.length < 2) return withSong;
  const snapped = retimeTexts(timeline, snapCutsToBeats(withSong, durations));
  return snapped.music?.onBeat ? putOnTheBeat(snapped, durations) : snapped;
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
  for (const key of ["plan", "details", "logo", "cover", "hook"] as const) {
    if (!same(before[key], after[key])) changes.push({ kind: "other", key });
  }
  return changes;
}
