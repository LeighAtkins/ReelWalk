/**
 * How text overlays keep their timing when the cut changes (ADR 0048). Every
 * path that changes clip lengths or order (the editor's own controls, the
 * beat snap, an AI edit, the draft review) moves titles through these
 * functions, so the same cut change moves the same titles the same way.
 */
import { addRoomLabels, clipDurationMs, clipStartsMs, hasRoomLabels, timelineDurationMs, type TextOverlay, type Timeline } from "./timeline";

/** A title that starts before this is an opening title: it is on the first frames of the reel, whatever the first clip's window does. */
export const OPENING_TITLE_MS = 500;
/** An opening title stays up at least this long when a change would cut it shorter (the house rule: readable from frame 0). */
export const OPENING_TITLE_MIN_MS = 1500;
/** No title is made shorter than this by a change to the cut, unless it was shorter when the user set it. */
export const MIN_TITLE_MS = 1200;

/** The shortest a change to the cut may leave `text`: its floor, or its own length when the user set it shorter. */
function titleFloorMs(text: TextOverlay, was: TextOverlay | undefined): number {
  const length = (was ?? text).endMs - (was ?? text).startMs;
  return Math.min(text.startMs < OPENING_TITLE_MS ? OPENING_TITLE_MIN_MS : MIN_TITLE_MS, length);
}

// ── Keeping the rest of the reel in step ────────────────────────

/**
 * Where a text sits relative to the clips: the clip it starts over, how far
 * in, and for how long. For a video the position is kept in the clip's own
 * source time (`sourceMs`, `sourceLengthMs`), so that when the clip is slowed
 * down, sped up or trimmed from its start, the text goes back over the same
 * picture; `offsetMs` and `durationMs` are the output times it had.
 */
export type TextAnchor = {
  textId: string;
  clipId: string;
  clipIndex: number;
  offsetMs: number;
  durationMs: number;
  sourceMs: number | null;
  sourceLengthMs: number | null;
};

/**
 * Records, for every text that is not a room label, which clip it starts
 * over, so that after clips are trimmed, moved or removed the text can go
 * back over the same picture rather than staying at the same second.
 */
export function anchorTexts(timeline: Timeline): TextAnchor[] {
  const starts = clipStartsMs(timeline);
  return timeline.texts
    .filter((text) => !text.id.startsWith("room-"))
    .map((text) => {
      let index = starts.findIndex((start, i) => text.startMs >= start && text.startMs < start + clipDurationMs(timeline.clips[i]));
      if (index === -1) index = Math.max(0, timeline.clips.length - 1);
      const clip = timeline.clips[index];
      const offsetMs = clip ? text.startMs - starts[index] : 0;
      const durationMs = text.endMs - text.startMs;
      const video = clip?.kind === "VIDEO";
      return {
        textId: text.id,
        clipId: clip?.id ?? "",
        clipIndex: index,
        offsetMs,
        durationMs,
        sourceMs: video ? clip.sourceStartMs + offsetMs * clip.speed : null,
        sourceLengthMs: video ? durationMs * clip.speed : null,
      };
    });
}

/**
 * Puts anchored texts back over their clips. A text whose clip was removed
 * goes over whichever clip now holds that position (so a title over the
 * first shot stays over the first shot); a text that was deleted stays gone.
 */
export function reflowTexts(timeline: Timeline, anchors: TextAnchor[], original: TextOverlay[] = []): Timeline {
  if (timeline.clips.length === 0) return timeline;
  const starts = clipStartsMs(timeline);
  const total = timelineDurationMs(timeline);
  const byId = new Map(anchors.map((anchor) => [anchor.textId, anchor]));
  // A text that fell off the end when the reel got shorter comes back if it was anchored.
  const present = new Set(timeline.texts.map((text) => text.id));
  const restored = original.filter((text) => byId.has(text.id) && !present.has(text.id));
  const texts = [...timeline.texts, ...restored].map((text): TextOverlay => {
    const anchor = byId.get(text.id);
    if (!anchor) return text;
    let index = timeline.clips.findIndex((clip) => clip.id === anchor.clipId);
    if (index === -1) index = Math.min(anchor.clipIndex, timeline.clips.length - 1);
    const clip = timeline.clips[index];
    const clipMs = clipDurationMs(clip);
    // The same picture: for a video that is the moment in its source, at the clip's speed now.
    let offsetMs = anchor.offsetMs;
    let durationMs = anchor.durationMs;
    if (clip.kind === "VIDEO" && clip.id === anchor.clipId && anchor.sourceMs !== null && anchor.sourceLengthMs !== null) {
      offsetMs = Math.round((anchor.sourceMs - clip.sourceStartMs) / clip.speed);
      durationMs = Math.round(anchor.sourceLengthMs / clip.speed);
      // Trimmed away from the start: the text shows from the clip's first frame, for no less than it is allowed to (never the old 100 ms sliver).
      if (offsetMs < 0) {
        durationMs = Math.max(Math.min(anchor.durationMs, MIN_TITLE_MS), durationMs + offsetMs);
        offsetMs = 0;
      }
    }
    const startMs = Math.min(starts[index] + Math.min(offsetMs, Math.max(0, clipMs - 100)), total - 100);
    const endMs = Math.min(total, startMs + durationMs);
    return endMs > startMs ? { ...text, startMs, endMs } : text;
  });
  return { ...timeline, texts };
}

// ── Which texts follow a clip, and which stay at their second ───

/**
 * A text's timing is either attached to one clip instance (by clip id, not
 * asset, so two uses of one video keep separate titles) or relative to the
 * reel. Room labels are neither: `addRoomLabels` draws them again.
 */
export type TextAttachment = { kind: "clip"; clipId: string } | { kind: "reel" } | { kind: "managed" };

/**
 * Where the picture a clip starts stops: the end of that clip, or of the run
 * of clips after it that continue the same source without a jump (the two
 * pieces of a split). A plain attached title may run to here, no further.
 */
export function clipRunEndMs(timeline: Timeline, index: number, starts: number[] = clipStartsMs(timeline)): number {
  let end = index;
  while (end + 1 < timeline.clips.length) {
    const here = timeline.clips[end];
    const next = timeline.clips[end + 1];
    if (next.assetId !== here.assetId || next.kind !== here.kind || next.sourceStartMs !== here.sourceEndMs || next.speed !== here.speed) break;
    end++;
  }
  return starts[end] + clipDurationMs(timeline.clips[end]);
}

/**
 * The rule (ADR 0048), derived from the saved data because v1 timelines have
 * no attachment field, and conservative on purpose (a text only follows a
 * clip when there is no doubt which one it belongs to):
 * - a room label (`room-…`) is managed;
 * - a pinned text (`pin`) is attached to the clip it starts over when that
 *   clip shows the pinned asset: its path was tracked on that picture;
 * - a text that starts and ends inside one clip (or inside the pieces of
 *   one split clip, which continue its source) is attached to that clip;
 * - anything else (a caption or hook spanning a cut, a text past the end) is
 *   reel-relative: it keeps its seconds and is only cut short at the end.
 *
 * Retiming keeps a plain attached text inside its clip (`retimeTexts`), so a
 * trim never turns it into a reel-relative one by pushing it over a cut.
 */
export function textAttachment(timeline: Timeline, text: TextOverlay): TextAttachment {
  if (text.id.startsWith("room-")) return { kind: "managed" };
  const starts = clipStartsMs(timeline);
  const index = starts.findIndex((start, i) => text.startMs >= start && text.startMs < start + clipDurationMs(timeline.clips[i]));
  if (index === -1) return { kind: "reel" };
  const clip = timeline.clips[index];
  if (text.pin && clip.assetId === text.pin.assetId) return { kind: "clip", clipId: clip.id };
  // An opening title belongs to the reel's first frames, not to whatever moment of the first clip it happened to cover.
  if (text.startMs < OPENING_TITLE_MS) return { kind: "reel" };
  return text.endMs <= clipRunEndMs(timeline, index, starts) ? { kind: "clip", clipId: clip.id } : { kind: "reel" };
}

/** `anchorTexts`, for the texts attached to a clip only. */
export function attachedAnchors(timeline: Timeline): TextAnchor[] {
  const attached = new Set(timeline.texts.filter((text) => textAttachment(timeline, text).kind === "clip").map((text) => text.id));
  return anchorTexts(timeline).filter((anchor) => attached.has(anchor.textId));
}

export type TextRetimeOptions = {
  /** Anchors taken from `before` (default: `attachedAnchors(before)`), for callers that adjust them (a split). */
  anchors?: TextAnchor[];
  /** Texts whose times were set on purpose by this change (an AI plan's own text edit): left where they are. */
  except?: ReadonlySet<string>;
  /** Texts that may come back when they fell off the end (default: all of `before`'s); a text deleted on purpose is left out. */
  kept?: TextOverlay[];
  /**
   * Whether a plain title that sat inside its own clip is cut at that clip's
   * end when this change shortened or moved the clip (default true). The
   * review's pace and length change every clip at once and leave titles whole.
   */
  keepInsideClip?: boolean;
};

/**
 * The one way texts are retimed after the cut changed from `before` to
 * `after`:
 * - attached texts go back over their clip's picture (`reflowTexts`); where a
 *   title belongs is decided once, from `before`: a plain (unpinned) title
 *   that sat inside its own clip is cut at that clip's end only when this
 *   change shortened or moved that clip, so a trim cannot push it over a cut
 *   and detach it; a title that already ran on over the pieces of a split
 *   is never cut;
 * - reel-relative texts keep the seconds they had in `before`: one the change
 *   only cut short, or dropped off the end, gets its time back (a trim
 *   dragged in and out again, AI steps that shorten the reel on the way);
 * - nothing runs past the end, and room labels, when the reel has them, are
 *   drawn again for the new cut.
 * Texts in `except`, and texts left out of `kept`, are not touched.
 */
export function retimeTexts(before: Timeline, after: Timeline, options: TextRetimeOptions = {}): Timeline {
  const except = options.except ?? new Set<string>();
  const kept = options.kept ?? before.texts;
  const anchors = (options.anchors ?? attachedAnchors(before)).filter((anchor) => !except.has(anchor.textId));
  let current = reflowTexts(after, anchors, kept);
  if (current.clips.length === 0) return { ...current, texts: [] };

  // A plain title inside its own clip stays inside it when this change shortened or moved that clip.
  const starts = clipStartsMs(current);
  const pinned = new Set(before.texts.filter((text) => text.pin).map((text) => text.id));
  const changed = (clipId: string) => {
    const was = before.clips.findIndex((clip) => clip.id === clipId);
    const now = current.clips.findIndex((clip) => clip.id === clipId);
    if (was === -1 || now === -1 || was !== now) return true;
    const a = before.clips[was];
    const b = current.clips[now];
    return a.sourceStartMs !== b.sourceStartMs || a.sourceEndMs !== b.sourceEndMs || a.speed !== b.speed;
  };
  const owner = new Map(
    (options.keepInsideClip === false ? [] : anchors)
      .filter((anchor) => {
        if (pinned.has(anchor.textId)) return false;
        const own = before.clips.find((clip) => clip.id === anchor.clipId) ?? current.clips.find((clip) => clip.id === anchor.clipId);
        return own !== undefined && anchor.offsetMs + anchor.durationMs <= clipDurationMs(own) && changed(anchor.clipId);
      })
      .map((anchor) => {
        let index = current.clips.findIndex((clip) => clip.id === anchor.clipId);
        if (index === -1) index = Math.min(anchor.clipIndex, current.clips.length - 1);
        return [anchor.textId, index] as const;
      }),
  );
  // Reel-relative texts get back the seconds they had before the change, unless it moved them on purpose.
  const anchored = new Set(anchors.map((anchor) => anchor.textId));
  const keptIds = new Set(kept.map((text) => text.id));
  const relative = new Map(
    before.texts
      .filter((text) => !anchored.has(text.id) && !except.has(text.id) && keptIds.has(text.id) && textAttachment(before, text).kind === "reel")
      .map((text) => [text.id, text]),
  );
  const present = new Set(current.texts.map((text) => text.id));
  const texts = [...current.texts, ...[...relative.values()].filter((text) => !present.has(text.id))].map((text) => {
    const moved = (): TextOverlay => {
      const index = owner.get(text.id);
      if (index !== undefined) {
        // Its clip's end, or the end of the pieces continuing it when this change was a split.
        const end = clipRunEndMs(current, index, starts);
        return text.endMs > end && end > text.startMs ? { ...text, endMs: end } : text;
      }
      const was = relative.get(text.id);
      // Only cut short (same start, earlier end): the original end comes back.
      if (was && text.startMs === was.startMs && text.endMs <= was.endMs) return { ...text, endMs: was.endMs };
      return text;
    };
    const next = moved();
    if (except.has(text.id) || text.id.startsWith("room-")) return next;
    // Whatever the change did, a title is not left a sliver (an opening title stays readable from frame 0).
    const floor = titleFloorMs(next, before.texts.find((entry) => entry.id === text.id));
    return next.endMs - next.startMs < floor ? { ...next, endMs: next.startMs + floor } : next;
  });
  const total = timelineDurationMs(current);
  current = { ...current, texts: texts.filter((text) => text.startMs < total).map((text) => (text.endMs > total ? { ...text, endMs: total } : text)) };
  return hasRoomLabels(current) ? addRoomLabels(current) : current;
}
