/**
 * The draft review (ADR 0022): quick changes to a finished cut without the
 * timeline. Each is a pure function on the timeline, so it lands as one
 * undoable step in the editor like everything else.
 */
import { cutsOnBeat } from "./ai-edit";
import { retimeTexts } from "./text-timing";
import { snapCutsToBeats } from "./beats";
import { MIN_CLIP_MS, addRoomLabels, clipDurationMs, hasRoomLabels, timelineDurationMs, trimClip, updateClip, type Filter, type Timeline } from "./timeline";

/** The rooms a shot can be named as: what the AI picks from, and what the studio can change it to. */
export const ROOM_NAMES = [
  "exterior",
  "aerial",
  "front door",
  "entry",
  "living room",
  "family room",
  "dining room",
  "kitchen",
  "primary bedroom",
  "bedroom",
  "bathroom",
  "office",
  "hallway",
  "stairs",
  "laundry",
  "garage",
  "pool",
  "patio",
  "balcony",
  "garden",
  "view",
] as const;

/** The pace choices in the review: seconds a shot plays. */
export const PACES = [
  { id: "faster", label: "Faster", shotMs: 2000 },
  { id: "steady", label: "Steady", shotMs: 3000 },
  { id: "slower", label: "Slower", shotMs: 4000 },
] as const;

/** Reel lengths offered in the review. */
export const REEL_LENGTHS_S = [15, 20, 30] as const;

/**
 * Every shot plays about `shotMs`: photos exactly, a 360 photo at least 3.5 s
 * (a sweep needs the time), a video as much as its source allows, keeping the
 * middle of what it showed. Texts follow their pictures, cuts that were on the
 * beat go back on it, room labels are redrawn.
 */
export function retime(timeline: Timeline, shotMs: number, sourceDurationsMs: Record<string, number | null | undefined> = {}): Timeline {
  const onBeat = cutsOnBeat(timeline) || Boolean(timeline.music?.bpm);
  let current = timeline;
  for (const clip of timeline.clips) {
    const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
    const want = Math.max(MIN_CLIP_MS, clip.pano ? Math.max(3500, shotMs) : shotMs);
    if (clip.kind === "IMAGE") {
      current = trimClip(current, clip.id, { sourceStartMs: 0, sourceEndMs: want });
      continue;
    }
    const source = sourceDurationsMs[clip.assetId] ?? clip.sourceEndMs;
    const length = Math.min(Math.round(want * speed), source);
    // Keep the middle of what the clip showed, moving out only as far as the source allows.
    const middle = (clip.sourceStartMs + clip.sourceEndMs) / 2;
    const start = Math.max(0, Math.min(source - length, Math.round(middle - length / 2)));
    current = trimClip(current, clip.id, { sourceStartMs: start, sourceEndMs: start + length }, source);
  }
  // Texts follow the same way as after any other cut change (ADR 0048).
  if (onBeat && current.music?.bpm) current = snapCutsToBeats(current, sourceDurationsMs);
  // Every clip changes at once: titles keep their length rather than being cut at their clip's end.
  return retimeTexts(timeline, current, { keepInsideClip: false });
}

/** The reel brought to about `totalMs` by giving every shot the same share, between 1.2 and 5 s. */
export function retimeToLength(timeline: Timeline, totalMs: number, sourceDurationsMs: Record<string, number | null | undefined> = {}): Timeline {
  if (timeline.clips.length === 0) return timeline;
  const shotMs = Math.max(1200, Math.min(5000, Math.round(totalMs / timeline.clips.length)));
  return retime(timeline, shotMs, sourceDurationsMs);
}

/** The pace a reel is closest to, for showing which choice is on. */
export function currentPace(timeline: Timeline): (typeof PACES)[number]["id"] | null {
  if (timeline.clips.length === 0) return null;
  const average = timelineDurationMs(timeline) / timeline.clips.length;
  const nearest = PACES.reduce((best, pace) => (Math.abs(pace.shotMs - average) < Math.abs(best.shotMs - average) ? pace : best), PACES[0]);
  return Math.abs(nearest.shotMs - average) <= 450 ? nearest.id : null;
}

/** The same look on every clip. */
export function setLook(timeline: Timeline, filter: Filter): Timeline {
  return timeline.clips.reduce((current, clip) => updateClip(current, clip.id, { filter }), timeline);
}

/** The look every clip shares, or null when they differ. */
export function currentLook(timeline: Timeline): Filter | null {
  const looks = new Set(timeline.clips.map((clip) => clip.filter));
  return looks.size === 1 ? [...looks][0] : null;
}

/** A clip's room, set by the studio; room labels are redrawn when they are on. */
export function setClipRoom(timeline: Timeline, clipId: string, room: string | null): Timeline {
  const next = { ...timeline, clips: timeline.clips.map((clip) => (clip.id === clipId ? { ...clip, room: room ? room.slice(0, 40) : null } : clip)) };
  return hasRoomLabels(next) ? addRoomLabels(next) : next;
}

/** "1240000" or "1,240,000" becomes "$1,240,000"; anything already carrying a currency sign or words is left alone. */
export function formatPrice(value: string): string {
  const text = value.trim();
  if (!text || /[^\d.,\s]/.test(text)) return text;
  const number = Number(text.replace(/[,\s]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return text;
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: number < 1000 ? 2 : 0 })}`;
}

/** "2400" becomes "2,400 sq ft"; anything with units or words already is left alone. */
export function formatArea(value: string): string {
  const text = value.trim();
  if (!text || /[^\d.,\s]/.test(text)) return text;
  const number = Number(text.replace(/[,\s]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return text;
  return `${number.toLocaleString("en-US", { maximumFractionDigits: 0 })} sq ft`;
}

/** Seconds a clip plays, for the review's short summary. */
export function averageShotMs(timeline: Timeline): number {
  return timeline.clips.length ? Math.round(timeline.clips.reduce((sum, clip) => sum + clipDurationMs(clip), 0) / timeline.clips.length) : 0;
}
