/**
 * Words on the wall as they are spoken (ADR 0084). A presenter says a line; the same words are painted on the wall
 * behind her, each one arriving on the frame she says it and the line fading when she has finished it. Two pure pieces:
 *
 *   lineOnPlane(plane, aspect, { at, capHeight })
 *     a title-shaped rectangle in a wall's own perspective, centred where it is asked to be and sized by the height
 *     of its capitals as drawn (a fraction of the frame's height). `fitTitleOnPlane` (ADR 0075) makes a title as big
 *     as the wall comfortably takes; a quiet line on a wall behind a speaker is far smaller than that and sits where
 *     the speaker's head and shoulder can cross it, so it is placed by size and spot instead.
 *
 *   alignSpokenLine(line, spoken) / speechSync(timeline, textId, speech, options)
 *     the title's words found in what the clip under it says (the worker's word-timed transcript, ADR 0035), and the
 *     title's timing from them: it starts with the first word, ends `holdMs` after the last (never past its shot),
 *     and the "words" reveal (ADR 0061) brings each word in at the moment it is said (`kinetic.wordsMs`).
 *
 * The `syncTextToSpeech` command (commands.ts) writes `speechSync`'s patch; the HTTP commands route fills in the
 * library's transcripts, so an agent sends only the title's id.
 */
import { applyHomography, homography, invertHomography, type Quad } from "./motion";
import { SURFACE_SAFE, surfacePlaneSize } from "./surface-finder";
import { TITLE_LEADING } from "./scene";
import { clipDurationMs, clipStartsMs, REEL_FORMAT, type Timeline, type TextOverlay } from "./timeline";
import { sourceToReelMs, transcriptWindow, type TranscriptWord } from "./transcript";
import { WORD_ARRIVE_MS } from "./kinetic";
import { levenshtein } from "./take-trim";

// ---------------------------------------------------------------- the line's place on the wall

/** Cap height over the em of the house serif (Playfair Display: 708 / 1000 units). */
export const SERIF_CAP_EM = 0.708;
/** Cap height of a quiet wall line by default: 2.5% of the frame's height (48 px at 1920). */
export const WALL_CAP_HEIGHT = 0.025;

export type LineOnPlane = {
  /** Corners (tl, tr, br, bl), frame fractions: the title's rectangle in the wall's perspective. Becomes `text.surface`. */
  quad: number[];
  /** Cap height as drawn, as a fraction of the frame's height (the mean of the rectangle's left and right edges). */
  capHeight: number;
};

const UNIT: Quad = [0, 0, 1, 0, 1, 1, 0, 1];
const toPx = (q: readonly number[]): Quad => q.map((v, i) => (i % 2 === 0 ? v * REEL_FORMAT.width : v * REEL_FORMAT.height)) as Quad;
const round4 = (v: number) => Number(v.toFixed(4));

/**
 * The title's rectangle on a plane (corners tl, tr, br, bl as frame fractions), centred on the frame point `at`
 * (which must be on the plane) with capitals `capHeight` of the frame tall where it is drawn. `aspect` is
 * `titleAspect(text)` and `lines` the text's number of lines (the rectangle is that many lines tall). The rectangle lives in the plane's own coordinates, so its sides follow the wall's
 * perspective: the far end of a line on a receding wall is shorter than the near end. Returns an error instead
 * when `at` is off the plane, or the line would leave the safe area of the frame.
 */
export function lineOnPlane(plane: readonly number[], aspect: number, options: { at: { x: number; y: number }; capHeight?: number; lines?: number; safe?: typeof SURFACE_SAFE }): LineOnPlane | { error: string } {
  const H = homography(UNIT, toPx(plane));
  const back = H && invertHomography(H);
  if (!H || !back) return { error: "The surface's corners do not make a plane." };
  const { width: Wl, height: Hl } = surfacePlaneSize(plane);
  if (Wl < 20 || Hl < 20) return { error: "The surface is too small to carry a line." };
  const [cu, cv] = applyHomography(back, options.at.x * REEL_FORMAT.width, options.at.y * REEL_FORMAT.height);
  if (!(cu >= 0 && cu <= 1 && cv >= 0 && cv <= 1)) return { error: `The point (${options.at.x}, ${options.at.y}) is not on the surface.` };
  const wantCap = (options.capHeight ?? WALL_CAP_HEIGHT) * REEL_FORMAT.height;
  const lines = Math.max(1, Math.round(options.lines ?? 1));
  // The rectangle's height in plane px is found by a few steps of proportion: the drawn height scales close to linearly with it.
  const rect = (th: number) => {
    const tw = th * aspect;
    const hu = tw / (2 * Wl), hv = th / (2 * Hl);
    const corners = ([[cu - hu, cv - hv], [cu + hu, cv - hv], [cu + hu, cv + hv], [cu - hu, cv + hv]] as [number, number][]).map(([u, v]) => applyHomography(H, u, v));
    const lineHeightPx = (Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]) + Math.hypot(corners[2][0] - corners[1][0], corners[2][1] - corners[1][1])) / 2;
    return { corners, capPx: (lineHeightPx * SERIF_CAP_EM) / (TITLE_LEADING * lines) };
  };
  let th = (wantCap * TITLE_LEADING * lines) / SERIF_CAP_EM;
  let found = rect(th);
  for (let step = 0; step < 6 && Math.abs(found.capPx - wantCap) > 0.25; step++) {
    th *= wantCap / Math.max(1e-6, found.capPx);
    found = rect(th);
  }
  const quad = found.corners.flatMap(([x, y]) => [x / REEL_FORMAT.width, y / REEL_FORMAT.height]);
  const safe = options.safe ?? SURFACE_SAFE;
  for (let i = 0; i < 4; i++) {
    const x = quad[i * 2], y = quad[i * 2 + 1];
    if (x < safe.left || x > safe.right || y < safe.top || y > safe.bottom) return { error: `At that size the line runs out of the safe area of the frame (a corner at ${x.toFixed(3)}, ${y.toFixed(3)}): move it, shorten it or make it smaller.` };
  }
  return { quad: quad.map(round4), capHeight: round4(found.capPx / REEL_FORMAT.height) };
}

/**
 * A wall's plane from one frame's lines (ADR 0084): a wall standing upright (its verticals are vertical in the frame)
 * whose horizontal lines (the ceiling edge, the skirting) meet at `vanishingPoint`, between the verticals `x0` and `x1`,
 * from height `top` to `bottom` measured on the vertical `x0`. All frame fractions; the vanishing point may lie off the
 * frame. Returns corners (tl, tr, br, bl): a rectangle of the wall in its own perspective, for `lineOnPlane`. Two
 * measured edges of a blank plaster wall are enough, where a model's region or the edge finder's quad is a rough box.
 */
export function wallPlane(input: { vanishingPoint: { x: number; y: number }; x0: number; x1: number; top: number; bottom: number }): number[] {
  const { vanishingPoint: vp, x0, x1, top, bottom } = input;
  if (Math.abs(vp.x - x0) < 1e-6) throw new Error("The vanishing point is on the wall's own vertical: there is no perspective to follow.");
  // The height at x of the line through (x0, y) and the vanishing point (straight lines stay straight in fractions).
  const at = (y: number, x: number) => y + ((vp.y - y) * (x - x0)) / (vp.x - x0);
  const [left, right] = x0 < x1 ? [x0, x1] : [x1, x0];
  return [left, at(top, left), right, at(top, right), right, at(bottom, right), left, at(bottom, left)].map(round4);
}

// ---------------------------------------------------------------- the line's words in what is said

export type SpokenWord = { text: string; startMs: number; endMs: number };

/** A word as compared: lower case, letters and digits only ("Walls." and "walls" are the same word; "I'll" is "ill"). */
export function normaliseWord(word: string): string {
  return word.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

/** How well a written word matches a heard one: 1 the same, 0.6 one letter off in a word of four or more (speech recognition's "wall"/"walls"), 0 otherwise. */
function wordScore(written: string, heard: string): number {
  if (!written || !heard) return 0;
  if (written === heard) return 1;
  if (Math.min(written.length, heard.length) >= 4 && levenshtein(written, heard) <= 1) return 0.6;
  return 0;
}

export type SpokenLineAlignment = {
  /** For each word of the line (split on spaces), the index of the spoken word it was heard as, or null. */
  matches: (number | null)[];
  /** Share of the line's words that were heard. */
  matched: number;
  /** When each of the line's words is said, ms: heard words their own start; a word not heard is placed between its neighbours. */
  wordStartsMs: number[];
  /** First word's start and last word's end, ms. */
  startMs: number;
  endMs: number;
  /** The spoken words the line was found in, joined, for a message. */
  heard: string;
};

/**
 * The line's words found, in order, in a list of spoken words (a longest-common-subsequence alignment that allows
 * one letter's difference in longer words). Null when fewer than `minMatched` of the line's words are heard.
 */
export function alignSpokenLine(line: string, spoken: readonly SpokenWord[], { minMatched = 0.6 }: { minMatched?: number } = {}): SpokenLineAlignment | null {
  const written = line.split(/\s+/).filter(Boolean);
  const a = written.map(normaliseWord), b = spoken.map((word) => normaliseWord(word.text));
  if (!a.length || !b.length) return null;
  // score[i][j]: best total over the first i written and first j heard words.
  const score = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const pair = wordScore(a[i - 1], b[j - 1]);
    score[i][j] = Math.max(score[i - 1][j], score[i][j - 1], pair > 0 ? score[i - 1][j - 1] + pair : -1);
  }
  const matches: (number | null)[] = new Array(a.length).fill(null);
  for (let i = a.length, j = b.length; i > 0 && j > 0;) {
    const pair = wordScore(a[i - 1], b[j - 1]);
    if (pair > 0 && score[i][j] === score[i - 1][j - 1] + pair) { matches[i - 1] = j - 1; i--; j--; }
    else if (score[i - 1][j] >= score[i][j - 1]) i--;
    else j--;
  }
  const heardCount = matches.filter((m) => m !== null).length;
  // Words that carry no letters ("—") are not counted against the line.
  const countable = a.filter(Boolean).length || 1;
  if (heardCount / countable < minMatched) return null;
  const first = matches.findIndex((m) => m !== null), last = matches.length - 1 - [...matches].reverse().findIndex((m) => m !== null);
  // Unheard words: evenly between the heard words either side (or the line's ends).
  const starts = matches.map((m) => (m === null ? NaN : spoken[m].startMs));
  for (let i = 0; i < starts.length; i++) {
    if (!Number.isNaN(starts[i])) continue;
    let lo = i - 1; while (lo >= 0 && Number.isNaN(starts[lo])) lo--;
    let hi = i + 1; while (hi < starts.length && Number.isNaN(starts[hi])) hi++;
    const from = lo >= 0 ? starts[lo] : spoken[matches[first]!].startMs;
    const to = hi < starts.length ? starts[hi] : spoken[matches[last]!].endMs;
    const span = (hi < starts.length ? hi : starts.length) - lo;
    starts[i] = Math.round(from + ((to - from) * (i - lo)) / Math.max(1, span));
  }
  const fromIndex = matches[first]!, toIndex = matches[last]!;
  return {
    matches,
    matched: Number((heardCount / countable).toFixed(3)),
    wordStartsMs: starts.map((ms, i) => Math.max(ms, i > 0 ? starts[i - 1] : ms)),
    startMs: spoken[fromIndex].startMs,
    endMs: spoken[toIndex].endMs,
    heard: spoken.slice(fromIndex, toIndex + 1).map((word) => word.text).join(" "),
  };
}

/**
 * The words a clip plays, in reel time: its own sound, or the sound under it (a J-cut, ADR 0069). `speech` is the
 * library's word-timed transcripts by asset id.
 */
export function spokenWordsOfClip(timeline: Timeline, clipIndex: number, speech: Readonly<Record<string, readonly TranscriptWord[]>>): SpokenWord[] {
  const clip = timeline.clips[clipIndex];
  if (!clip) return [];
  const clipStartMs = clipStartsMs(timeline)[clipIndex];
  const endMs = clipStartMs + clipDurationMs(clip);
  const toWords = (words: readonly TranscriptWord[] | undefined, fromSourceMs: number, toReel: (sourceMs: number) => number) =>
    transcriptWindow({ text: "", words: [...(words ?? [])] }, fromSourceMs, fromSourceMs + 3_600_000)
      .map((word) => ({ text: word.w, startMs: toReel(word.s), endMs: toReel(word.e) }))
      .filter((word) => word.endMs > clipStartMs && word.startMs < endMs);
  if (clip.audio) {
    // A J-cut plays another asset from its sourceStartMs at 1×, from the clip's start.
    const { assetId, sourceStartMs } = clip.audio;
    return toWords(speech[assetId], sourceStartMs, (sourceMs) => clipStartMs + (sourceMs - sourceStartMs));
  }
  return toWords(speech[clip.assetId], clip.sourceStartMs, (sourceMs) => sourceToReelMs(clip, clipStartMs, sourceMs));
}

/** How long a wall line stays after its last word by default, ms. */
export const SPOKEN_HOLD_MS = 700;
/** How far ahead of the word a word starts to arrive, ms, so it is legible as it is said. */
export const SPOKEN_LEAD_MS = 60;

export type SpeechSync = {
  patch: Pick<TextOverlay, "startMs" | "endMs" | "kinetic">;
  alignment: SpokenLineAlignment;
  clipId: string;
};

/**
 * The timing of a title from the words it repeats: the clip it is over (or `clipId`), the words that clip plays,
 * the title's words found in them, and a patch that starts the title `leadMs` before its first word, ends it
 * `holdMs` after its last (never past the shot's end, and at least 1.2 s on screen), and brings each word in when
 * it is said with the "words" reveal. Throws a plain error an agent can act on when the words are not heard.
 */
export function speechSync(
  timeline: Timeline,
  textId: string,
  speech: Readonly<Record<string, readonly TranscriptWord[]>>,
  options: { clipId?: string; holdMs?: number; leadMs?: number } = {},
): SpeechSync {
  const text = timeline.texts.find((t) => t.id === textId);
  if (!text) throw new Error(`There is no text called ${textId} in the reel.`);
  const starts = clipStartsMs(timeline);
  const index = options.clipId
    ? timeline.clips.findIndex((clip) => clip.id === options.clipId)
    : timeline.clips.findIndex((clip, i) => text.startMs >= starts[i] && text.startMs < starts[i] + clipDurationMs(clip));
  if (index < 0) throw new Error(options.clipId ? `There is no clip called ${options.clipId} in the reel.` : "The title does not start over a clip: say which clip says its words with clipId.");
  const clip = timeline.clips[index];
  const spoken = spokenWordsOfClip(timeline, index, speech);
  if (!spoken.length) throw new Error(`Clip ${clip.id} has no transcribed speech, so there are no words to follow. A voiced take is transcribed when it is made; an upload, a few seconds after it is added.`);
  const alignment = alignSpokenLine(text.text, spoken);
  if (!alignment) throw new Error(`The words of ${textId} ("${text.text}") are not what clip ${clip.id} says: it says "${spoken.map((w) => w.text).join(" ")}". Write the line as it is said, or pick the clip that says it.`);
  const clipStartMs = starts[index], clipEndMs = clipStartMs + clipDurationMs(clip);
  const leadMs = Math.max(0, options.leadMs ?? SPOKEN_LEAD_MS), holdMs = Math.max(0, options.holdMs ?? SPOKEN_HOLD_MS);
  const startMs = Math.max(clipStartMs, Math.round(alignment.wordStartsMs[0] - leadMs));
  const endMs = Math.min(clipEndMs, Math.max(Math.round(alignment.endMs + holdMs), startMs + 1200));
  if (endMs <= startMs) throw new Error(`The words of ${textId} are said after clip ${clip.id} ends.`);
  // Each word arrives `leadMs` ahead of being said, relative to the title's start; the reveal is the "words" one (ADR 0061).
  const wordsMs = alignment.wordStartsMs.map((ms) => Math.max(0, Math.round(ms - leadMs - startMs)));
  const durationMs = Math.max(100, wordsMs[wordsMs.length - 1] + WORD_ARRIVE_MS);
  return { patch: { startMs, endMs, kinetic: { preset: "words", startMs: wordsMs[0], durationMs, wordsMs } }, alignment, clipId: clip.id };
}
