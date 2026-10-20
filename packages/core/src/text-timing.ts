/**
 * How text overlays keep their timing when the cut changes (ADR 0048). Every
 * path that changes clip lengths or order (the editor's own controls, the
 * beat snap, an AI edit, the draft review) moves titles through these
 * functions, so the same cut change moves the same titles the same way.
 */
import { addRoomLabels, clipDurationMs, clipStartsMs, hasRoomLabels, timelineDurationMs, type TextOverlay, type Timeline } from "./timeline";

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
      // Trimmed away from the start: the text shows from the clip's first frame.
      if (offsetMs < 0) {
        durationMs = Math.max(100, durationMs + offsetMs);
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
 * The rule (ADR 0048), derived from the saved data because v1 timelines have
 * no attachment field, and conservative on purpose (a text only follows a
 * clip when there is no doubt which one it belongs to):
 * - a room label (`room-…`) is managed;
 * - a pinned text (`pin`) is attached to the clip it starts over when that
 *   clip shows the pinned asset: its path was tracked on that picture;
 * - a text that starts and ends inside one clip is attached to that clip;
 * - anything else (a caption or hook spanning a cut, a text past the end) is
 *   reel-relative: it keeps its seconds and is only cut short at the end.
 */
export function textAttachment(timeline: Timeline, text: TextOverlay): TextAttachment {
  if (text.id.startsWith("room-")) return { kind: "managed" };
  const starts = clipStartsMs(timeline);
  const index = starts.findIndex((start, i) => text.startMs >= start && text.startMs < start + clipDurationMs(timeline.clips[i]));
  if (index === -1) return { kind: "reel" };
  const clip = timeline.clips[index];
  if (text.pin && clip.assetId === text.pin.assetId) return { kind: "clip", clipId: clip.id };
  return text.endMs <= starts[index] + clipDurationMs(clip) ? { kind: "clip", clipId: clip.id } : { kind: "reel" };
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
};

/**
 * The one way texts are retimed after the cut changed from `before` to
 * `after`: attached texts go back over their clip's picture (`reflowTexts`),
 * reel-relative texts keep their seconds, nothing runs past the end, and room
 * labels, when the reel has them, are drawn again for the new cut.
 */
export function retimeTexts(before: Timeline, after: Timeline, options: TextRetimeOptions = {}): Timeline {
  const except = options.except ?? new Set<string>();
  const anchors = (options.anchors ?? attachedAnchors(before)).filter((anchor) => !except.has(anchor.textId));
  let current = reflowTexts(after, anchors, options.kept ?? before.texts);
  const total = timelineDurationMs(current);
  current = {
    ...current,
    texts: current.texts.filter((text) => text.startMs < total).map((text) => (text.endMs > total ? { ...text, endMs: total } : text)),
  };
  return hasRoomLabels(current) ? addRoomLabels(current) : current;
}
