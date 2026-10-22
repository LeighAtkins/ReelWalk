import { isGeneratedAssetId } from "./presenter";
import { clipDurationMs, MIN_CLIP_MS, type Clip, type Timeline } from "./timeline";

/**
 * Cutaways over a presenter line (ADR 0069). A presenter standing and
 * talking for eight seconds is the slowest picture in a reel. "Cutaway every
 * N seconds" cuts from her to matching b-roll from the reel's own media for
 * a moment while her voice carries on under it (a J-cut: the b-roll clip's
 * `audio` is her take, from the same source time), then back to her. Pure,
 * deterministic (clip ids come from the take's id), and reversible:
 * `removeCutaways` rejoins the pieces.
 */
export const CUTAWAY_EVERY_CHOICES_MS = [3000, 4000, 5000] as const;
export const CUTAWAY_MIN_EVERY_MS = 2000;
export const CUTAWAY_HOLD_MS = 1500;

const CUT_ID = /^(.*)-cut-(\d+)$/;
const AFTER_ID = /^(.*)-after-(\d+)$/;

/** A clip that carries a presenter line: a generated take with its own sound, not a piece a cutaway already made. */
export function isPresenterTake(clip: Clip): boolean {
  return clip.kind === "VIDEO" && clip.volume > 0 && !clip.audio && (clip.id.startsWith("script-") || isGeneratedAssetId(clip.assetId))
    && !CUT_ID.test(clip.id) && !AFTER_ID.test(clip.id);
}

/** B-roll for a take: the reel's own footage (never a take, a generated clip or a 360 photo), the same room first, then the nearest in the cut. */
export function brollFor(timeline: Timeline, takeIndex: number): Clip[] {
  const take = timeline.clips[takeIndex];
  const candidates = timeline.clips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => clip !== take && !clip.pano && !isGeneratedAssetId(clip.assetId) && !isPresenterTake(clip) && !clip.audio && !CUT_ID.test(clip.id) && !AFTER_ID.test(clip.id));
  const sameRoom = (clip: Clip) => Boolean(take.room && clip.room && clip.room.toLowerCase() === take.room.toLowerCase());
  return candidates
    .sort((a, b) => Number(sameRoom(b.clip)) - Number(sameRoom(a.clip)) || Math.abs(a.index - takeIndex) - Math.abs(b.index - takeIndex) || a.index - b.index)
    .map(({ clip }) => clip);
}

/** The `holdMs` window of b-roll the k-th cutaway shows from a candidate, spread across its source so repeats differ. */
export function brollWindow(candidate: Clip, k: number, holdMs: number): { sourceStartMs: number; sourceEndMs: number } {
  if (candidate.kind === "IMAGE") return { sourceStartMs: 0, sourceEndMs: holdMs };
  const span = candidate.sourceEndMs - candidate.sourceStartMs;
  const room = Math.max(0, span - holdMs);
  const fraction = ((k * 0.382) % 1);
  const start = candidate.sourceStartMs + Math.round(room * fraction);
  return { sourceStartMs: start, sourceEndMs: start + (room > 0 ? holdMs : span) };
}

/** The spacing the reel's cutaways were made with (the take piece before the first cutaway), or null without any. */
export function cutawaySpacing(timeline: Timeline): number | null {
  const index = timeline.clips.findIndex(clip => /-cut-1$/.test(clip.id) && clip.audio);
  if (index < 1) return null;
  return clipDurationMs(timeline.clips[index - 1]);
}

export type CutawayOptions = {
  /** Reel milliseconds of the take between cutaways; null or 0 removes them. */
  everyMs: number | null;
  holdMs?: number;
  /** Only these takes (clip ids); every presenter take otherwise. */
  clipIds?: string[];
};

/** The cutaway clips removed and the take pieces joined back (the source a cutaway covered is shown again), so the command can be run again with another spacing. */
export function removeCutaways(timeline: Timeline, clipIds?: string[]): Timeline {
  const only = clipIds ? new Set(clipIds) : null;
  const owner = (id: string) => (CUT_ID.exec(id) ?? AFTER_ID.exec(id))?.[1] ?? null;
  const kept: Clip[] = [];
  let changed = false;
  for (const clip of timeline.clips) {
    const base = owner(clip.id);
    if (base && only && !only.has(base)) { kept.push(clip); continue; }
    if (base && CUT_ID.test(clip.id) && clip.audio) { changed = true; continue; }
    const previous = kept[kept.length - 1];
    if (base && AFTER_ID.test(clip.id) && previous && previous.assetId === clip.assetId && (previous.id === base || owner(previous.id) === base) && clip.sourceStartMs >= previous.sourceEndMs) {
      kept[kept.length - 1] = { ...previous, sourceEndMs: clip.sourceEndMs };
      changed = true;
      continue;
    }
    kept.push(clip);
  }
  return changed ? { ...timeline, clips: kept } : timeline;
}

/**
 * Cutaways every `everyMs` of each presenter take, each `holdMs` long, with
 * her voice continuing under the b-roll. A take too short for one (less than
 * every + hold + the shortest clip) is left whole. Existing cutaways are
 * removed first, so the result depends only on the reel and the spacing.
 */
export function planCutaways(timeline: Timeline, options: CutawayOptions): Timeline {
  const base = removeCutaways(timeline, options.clipIds);
  const everyMs = options.everyMs ?? 0;
  if (everyMs < CUTAWAY_MIN_EVERY_MS) return base;
  const holdMs = Math.max(MIN_CLIP_MS, Math.round(options.holdMs ?? CUTAWAY_HOLD_MS));
  const only = options.clipIds ? new Set(options.clipIds) : null;
  const next: Clip[] = [];
  let changed = false;
  base.clips.forEach((clip, index) => {
    if (!isPresenterTake(clip) || (only && !only.has(clip.id))) { next.push(clip); return; }
    const broll = brollFor(base, index);
    const length = clipDurationMs(clip);
    if (!broll.length || length < everyMs + holdMs + MIN_CLIP_MS) { next.push(clip); return; }
    const speed = clip.speed;
    let piece: Clip = clip;
    let pieceStartMs = 0;
    let k = 0;
    for (let at = everyMs; at + holdMs + MIN_CLIP_MS <= length; at += everyMs + holdMs) {
      k += 1;
      const candidate = broll[(k - 1) % broll.length];
      const window = brollWindow(candidate, k, holdMs);
      const cutSource = clip.sourceStartMs + Math.round(at * speed);
      next.push({ ...piece, sourceEndMs: cutSource });
      next.push({
        ...candidate, id: `${clip.id}-cut-${k}`, ...window, speed: 1, volume: 0, transitionIn: "cut",
        audio: { assetId: clip.assetId, sourceStartMs: cutSource, volume: clip.volume },
      });
      pieceStartMs = at + holdMs;
      piece = { ...clip, id: `${clip.id}-after-${k}`, sourceStartMs: clip.sourceStartMs + Math.round(pieceStartMs * speed), transitionIn: "cut" };
      changed = true;
    }
    next.push(piece);
  });
  return changed ? { ...base, clips: next } : base;
}
