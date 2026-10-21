/**
 * Kinetic type (ADR 0061): how a title's words arrive, as pure functions of
 * the time since the title appeared, so preview, still and export agree.
 *
 * API
 *
 *   kineticProgress(spec, titleMs): number   0 before `startMs`, 1 after the move.
 *
 *   wordReveal(text, spec, titleMs): WordPart[]
 *     "words": the text split into words and the space between them (kept, so
 *     the layout is the full text's); each word fades up from a little below,
 *     unblurring, staggered across the move.
 *
 *   slideFromBehind({ spec, titleMs, textLeft, textRight, edge }): { dx, clipLeft?, clipRight? }
 *     "behind": the words slide out from behind an edge (a post, a cut-out or
 *     a tapped object in front of the surface, or the text's own left edge),
 *     clipped at that edge so they appear from behind it. All in one px space
 *     (plane px for a surface title).
 *
 *   revealEdge({ textLeft, textRight, textTop, textBottom, shapes, points }): number
 *     the edge to slide out from: the centre of the post, cut-out or tapped
 *     point nearest the text's centre, among those level with the words (a
 *     shape whose height overlaps the line band, a tap inside the band grown by
 *     a quarter of its height); the text's left edge when there is none.
 *
 *   behindInPlane(placement, size): { textLeft, textRight, textTop, textBottom, taps, edge }
 *     the same for a surface title, everything in plane px: the words' box
 *     centred in the plane's rectangle, the tapped objects carried back into
 *     the plane through this frame's homography (`occluderTapsInPlane`), and
 *     the edge the renderer slides from.
 *
 *   countUpText(text, progress): string
 *     "count": every number in the text counts up from 0, in the text's own
 *     format ("$1.2M", "4 BED", "2,400 sq ft"): same decimals, same grouping.
 *
 *   typeMotionCues(text) / setTypeMotionCue(text, key, reelMs, fps) / snapTypeMotionToBeat(text, music, fps)
 *     the reel times at which a title's shine and kinetic move begin, for the
 *     pacing work (ADR 0059) to snap; setting one stores it relative to the
 *     title, on a whole frame.
 */
import { beatPeriodMs, nearestBeatMs } from "./beats";
import type { KineticPreset, Music, TextOverlay } from "./timeline";
import { REEL_FORMAT, TYPE_MOTION_START_MAX_MS } from "./timeline";
import { applyHomography, invertHomography } from "./motion";
import type { ScenePoint, SurfacePlacement } from "./scene";
import { SHINE_PRESET } from "./shine";

export type KineticSpec = NonNullable<TextOverlay["kinetic"]>;

/** Each preset's own start (ms after the title appears) and length. */
export const KINETIC_PRESET: Record<KineticPreset, { startMs: number; durationMs: number }> = {
  words: { startMs: 0, durationMs: 900 },
  behind: { startMs: 0, durationMs: 900 },
  count: { startMs: 150, durationMs: 1200 },
};

export const KINETIC_LABELS: Record<KineticPreset, string> = { words: "Word by word", behind: "From behind", count: "Count up" };

/** How long one word takes to arrive in "words". */
export const WORD_ARRIVE_MS = 420;
/** How far below its place a word starts, em. */
export const WORD_RISE_EM = 0.35;
/** How blurred a word starts, px at 1080. */
export const WORD_BLUR_PX = 6;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const easeOutCubic = (p: number) => 1 - Math.pow(1 - clamp01(p), 3);
const easeOutExpo = (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(p)));

export function kineticTiming(spec: KineticSpec): { startMs: number; durationMs: number } {
  const preset = KINETIC_PRESET[spec.preset];
  return { startMs: spec.startMs ?? preset.startMs, durationMs: spec.durationMs ?? preset.durationMs };
}

/** Linear progress of the move: 0 before it starts, 1 once it is done. */
export function kineticProgress(spec: KineticSpec, titleMs: number): number {
  const { startMs, durationMs } = kineticTiming(spec);
  return clamp01((titleMs - startMs) / Math.max(1, durationMs));
}

export type WordPart = { text: string; space: boolean; opacity: number; rise: number; blur: number };

/** "words": each word's state on this frame. Spaces and line breaks are kept as parts of their own. */
export function wordReveal(text: string, spec: KineticSpec, titleMs: number): WordPart[] {
  const parts = text.split(/(\s+)/).filter((part) => part !== "");
  const words = parts.filter((part) => !/^\s+$/.test(part)).length;
  const { startMs, durationMs } = kineticTiming(spec);
  const arrive = Math.min(WORD_ARRIVE_MS, durationMs);
  const stagger = words > 1 ? Math.max(0, durationMs - arrive) / (words - 1) : 0;
  let index = 0;
  return parts.map((part) => {
    if (/^\s+$/.test(part)) return { text: part, space: true, opacity: 1, rise: 0, blur: 0 };
    const e = easeOutCubic((titleMs - startMs - index++ * stagger) / arrive);
    return { text: part, space: false, opacity: Number(e.toFixed(4)), rise: Number(((1 - e) * WORD_RISE_EM).toFixed(4)), blur: Number(((1 - e) * WORD_BLUR_PX).toFixed(3)) };
  });
}

/**
 * "behind": where the words are and what is cut on this frame. The words travel away from `edge` (to the right when
 * their centre is right of it), from wholly behind it (their near edge at `edge`) to their place, easing out; the side
 * of `edge` they come from is clipped. If the text at rest reaches past the edge (a post across the words), the clip
 * opens over the last 15% of the move so the rest of the words show; the post's own cut hides what it covers.
 */
export function slideFromBehind(input: { spec: KineticSpec; titleMs: number; textLeft: number; textRight: number; edge: number }): { dx: number; clipLeft?: number; clipRight?: number; progress: number } {
  const { spec, titleMs, textLeft, textRight, edge } = input;
  const progress = kineticProgress(spec, titleMs);
  const e = easeOutExpo(progress);
  const open = clamp01((progress - 0.85) / 0.15);
  const right = (textLeft + textRight) / 2 >= edge;
  if (right) {
    const dx = (edge - textRight) * (1 - e);
    const clip = edge + (Math.min(edge, textLeft) - 1 - edge) * open;
    return { dx, clipLeft: clip, progress };
  }
  const dx = (edge - textLeft) * (1 - e);
  const clip = edge + (Math.max(edge, textRight) + 1 - edge) * open;
  return { dx, clipRight: clip, progress };
}

/**
 * The edge to slide out from: the post, cut-out or tapped point (x, px) nearest the text's centre, among those level
 * with the words when the line band is given; the text's left edge when there is none. A post above or below the
 * line is not something the words could be behind.
 */
export function revealEdge(input: {
  textLeft: number; textRight: number; textTop?: number; textBottom?: number;
  shapes?: readonly (readonly number[])[] | null; points?: readonly { x: number; y: number }[] | null;
}): number {
  const centre = (input.textLeft + input.textRight) / 2;
  const banded = input.textTop !== undefined && input.textBottom !== undefined;
  const top = input.textTop ?? -Infinity, bottom = input.textBottom ?? Infinity;
  const grow = banded ? (bottom - top) / 4 : 0;
  const level = (shape: readonly number[]) => {
    if (!banded) return true;
    const ys = shape.filter((_, i) => i % 2 === 1);
    return Math.max(...ys) >= top && Math.min(...ys) <= bottom;
  };
  const candidates = [
    ...(input.shapes ?? []).filter(level).map((shape) => { const xs = shape.filter((_, i) => i % 2 === 0); return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); }),
    ...(input.points ?? []).filter((point) => point.y >= top - grow && point.y <= bottom + grow).map((point) => point.x),
  ].filter((x) => Number.isFinite(x));
  if (!candidates.length) return input.textLeft;
  return candidates.reduce((best, x) => (Math.abs(x - centre) < Math.abs(best - centre) ? x : best));
}

/** A surface title's tapped objects on this frame (`occluderTaps`, fractions) carried back into its plane (plane px) through this frame's homography. */
export function occluderTapsInPlane(placement: Pick<SurfacePlacement, "homography" | "occluderTaps">, size: { width: number; height: number }): ScenePoint[] {
  const inverse = placement.homography ? invertHomography(placement.homography) : null;
  if (!inverse) return [];
  return placement.occluderTaps.map((tap) => { const [x, y] = applyHomography(inverse, tap.x * size.width, tap.y * size.height); return { x, y }; });
}

/** "From behind" on a surface title: the words' box in plane px (centred in the rectangle, at the fit scale), the taps in plane px, and the edge to slide from. */
export function behindInPlane(placement: Pick<SurfacePlacement, "rect" | "lineBox" | "fitScale" | "maskShapes" | "homography" | "occluderTaps">, size: { width: number; height: number }): { textLeft: number; textRight: number; textTop: number; textBottom: number; taps: ScenePoint[]; edge: number } {
  const lineW = placement.lineBox.width * placement.fitScale, lineH = placement.lineBox.height * placement.fitScale;
  const textLeft = (placement.rect.width - lineW) / 2, textTop = (placement.rect.height - lineH) / 2;
  const box = { textLeft, textRight: textLeft + lineW, textTop, textBottom: textTop + lineH };
  const taps = occluderTapsInPlane(placement, size);
  return { ...box, taps, edge: revealEdge({ ...box, shapes: placement.maskShapes, points: taps }) };
}

/** A number as written in the text: "1,250", "1.2", "4". */
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Whether the text has a number to count. */
export function hasCountableNumber(text: string): boolean {
  return /\d/.test(text);
}

/** "count": every number in the text at `progress` (0..1, eased here) of the way up from 0, written as the text writes it. */
export function countUpText(text: string, progress: number): string {
  const e = easeOutCubic(progress);
  return text.replace(NUMBER, (match) => {
    const grouped = match.includes(",");
    const plain = match.replace(/,/g, "");
    const decimals = plain.includes(".") ? plain.split(".")[1].length : 0;
    const value = Number(plain) * e;
    // Rounded down while counting, so the last frame is the first to show the full number.
    const scale = Math.pow(10, decimals);
    const shown = e >= 1 ? Number(plain) : Math.floor(value * scale + 1e-9) / scale;
    const fixed = shown.toFixed(decimals);
    if (!grouped) return fixed;
    const [whole, fraction] = fixed.split(".");
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction !== undefined ? `.${fraction}` : "");
  });
}

export type TypeMotionKey = "shine" | "kinetic";
export type TypeMotionCue = { textId: string; key: TypeMotionKey; reelMs: number };

/** When this title's shine and kinetic move begin, in reel ms (ADR 0061): what the pacing work (ADR 0059) may snap. */
export function typeMotionCues(text: TextOverlay): TypeMotionCue[] {
  const cues: TypeMotionCue[] = [];
  if (text.shine) cues.push({ textId: text.id, key: "shine", reelMs: text.startMs + (text.shine.startMs ?? SHINE_PRESET[text.shine.preset].startMs) });
  if (text.kinetic) cues.push({ textId: text.id, key: "kinetic", reelMs: text.startMs + kineticTiming(text.kinetic).startMs });
  return cues;
}

/** Moves one cue to `reelMs`, on a whole frame and inside the title's time. A title without that motion is returned unchanged. */
export function setTypeMotionCue(text: TextOverlay, key: TypeMotionKey, reelMs: number, fps: number = REEL_FORMAT.fps): TextOverlay {
  const motion = text[key];
  if (!motion) return text;
  const onFrame = Math.round((Math.round(((reelMs - text.startMs) * fps) / 1000) * 1000) / fps);
  const startMs = Math.max(0, Math.min(text.endMs - text.startMs - 1, TYPE_MOTION_START_MAX_MS, onFrame));
  return { ...text, [key]: { ...motion, startMs } };
}

/** Every cue of the title on the beat nearest it, when the music has a known tempo; otherwise unchanged. */
export function snapTypeMotionToBeat(text: TextOverlay, music: Pick<Music, "bpm" | "beatOffsetMs" | "sourceStartMs"> | null | undefined, fps: number = REEL_FORMAT.fps): TextOverlay {
  if (!music?.bpm || music.beatOffsetMs === null || music.beatOffsetMs === undefined) return text;
  const grid = { bpm: music.bpm, offsetMs: music.beatOffsetMs };
  return typeMotionCues(text).reduce((current, cue) => {
    let beat = nearestBeatMs(cue.reelMs, grid, music.sourceStartMs);
    // A beat before the title appears cannot start its move: take the next one.
    while (beat < text.startMs) beat += beatPeriodMs(grid);
    return setTypeMotionCue(current, cue.key, beat, fps);
  }, text);
}
