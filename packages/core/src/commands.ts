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
import { retime, retimeToLength } from "./review";
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
  /** The draft review's pace and length (ADR 0022). */
  | { type: "retime"; shotMs: number }
  | { type: "retimeToLength"; totalMs: number }
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
};

export type Change = { kind: "clip"; id: string } | { kind: "text"; id: string } | { kind: "music" } | { kind: "other"; key: string };

export type CommandResult = {
  timeline: Timeline;
  /** What changed, clip by clip and text by text (empty when nothing did). */
  changes: Change[];
  /** Set when a proposal was computed against an older generation; `timeline` is then the current one, untouched. */
  stale?: true;
};

/** Applies one command. Pure: the same timeline and command always give the same result. */
export function applyCommand(timeline: Timeline, command: Command, context: CommandContext): CommandResult {
  if (command.type === "applyProposal" && command.baseGeneration !== context.generation) return { timeline, changes: [], stale: true };
  const next = run(timeline, command, context);
  return { timeline: next, changes: next === timeline ? [] : diffTimelines(timeline, next) };
}

function run(timeline: Timeline, command: Command, context: CommandContext): Timeline {
  const durations = context.sourceDurationsMs ?? {};
  const sourceOf = (clipId: string) => {
    const clip = timeline.clips.find((item) => item.id === clipId);
    return clip ? (durations[clip.assetId] ?? undefined) : undefined;
  };
  // Every cut change goes through retimeTexts, against the timeline it started from.
  const cut = (after: Timeline, options?: Parameters<typeof retimeTexts>[2]) => (after === timeline ? timeline : retimeTexts(timeline, after, options));

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
    case "snapToBeat":
      return timeline.clips.length < 2 ? timeline : cut(snapCutsToBeats(timeline, durations));
    case "retime":
      return retime(timeline, command.shotMs, durations);
    case "retimeToLength":
      return retimeToLength(timeline, command.totalMs, durations);
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
  const withSong = setMusic(timeline, choice ? { ...choice, volume: choice.volume ?? timeline.music?.volume ?? 0.8 } : null);
  if (!snap || !withSong.music?.bpm || withSong.clips.length < 2) return withSong;
  return retimeTexts(timeline, snapCutsToBeats(withSong, durations));
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
