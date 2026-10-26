/**
 * The keyword lockup (ADR 0089): a talking head's words turned into type the way the owner's reference reels do it
 * (output/references, reel 3 "one question", measured frame by frame on 2026-10-26). Per spoken phrase:
 *
 *   - one KEYWORD, huge (capitals 7–14 % of the frame's height; 8.5 % by default, the reference's median), in the house
 *     serif at weight 600, white unless a gradient or picture fill is asked for, standing behind the presenter's head
 *     (the person matte, `behind`) so her hair covers the bottom third of the letters, arriving on its onset out of an
 *     8 px blur in 200 ms ("blurQuick", the measured arrival) and gone when the phrase ends;
 *   - every other word in a CAPTION track: small (capitals about 2.75 %), white, soft shadow, italic, one word at a time,
 *     each cut on 40 ms before it is said and replaced by the next (kinetic "caption"), kept under her chin, inside
 *     the app's Instagram safe area (under the header, above y 0.72, left of the like/share column at x 960 px);
 *   - or, for a short phrase (four words or fewer), the other words INTERLOCKED with the keyword (ADR 0089 addendum):
 *     small italic COMPANIONS tucked into the keyword's block, the words said before it over its top-left, the words
 *     after it under its right half, overlapping its capitals the way reel 3 sets "you hire" under "Before".
 *
 * Pure: `composeKeywordLockups(timeline, options)` returns the timeline with the lockups of the chosen clips replaced,
 * and `describeLockups(timeline)` what a dry run shows. The `composeKeywordLockup` command (commands.ts) runs it; the
 * HTTP route fills in the library's transcripts and the presenter's face boxes.
 */
import { estimateLineWidth } from "./cinematic";
import { SAFE_AREA } from "./instagram";
import { clipPicture, onScreenAt, sourceToComposition } from "./view";
import { clipDurationMs, clipStartsMs, KEYWORD_SIZE_MAX, REEL_FORMAT, TEXT_SAFE_BOTTOM, textSchema, type TextOverlay, type Timeline } from "./timeline";
import { normaliseWord, spokenWordsOfClip, SERIF_CAP_EM, type SpokenWord } from "./wall-text";
import type { TranscriptWord } from "./transcript";

export type TextFill = NonNullable<TextOverlay["fill"]>;

/** The presenter's face on a take, as the identity gate found it (source fractions of a `width`×`height` source). */
export type FaceInput = { x0: number; y0: number; x1: number; y1: number; width: number; height: number };

export type LockupOptions = {
  /** The clips to compose; default every clip whose sound has words. Lockups already on these clips are replaced. */
  clipIds?: string[];
  /**
   * Keywords to use: a phrase that says one of these (any case, punctuation ignored) takes it as its keyword. A phrase
   * that says none of them gets the default pick, or none when `keywordsOnly`.
   */
  keywords?: string[];
  keywordsOnly?: boolean;
  /** Capitals of the keyword as a fraction of the frame's height, 0.05–0.14 (default 0.085). A long word comes down to fit. */
  capHeight?: number;
  /** Fill for every keyword (default: solid white). */
  fill?: TextFill;
  /** The keyword's colour when it has no fill (default white). */
  color?: string;
  /** The caption track (default on). */
  captions?: boolean;
  /**
   * Short phrases (INTERLOCK_MAX_WORDS words or fewer, the keyword included) set their other words as companions
   * interlocked with the keyword instead of the caption track (default on). Longer phrases keep the caption track.
   */
  interlock?: boolean;
  /** Where a keyword's centre goes, by keyword (lower case), frame fractions; overrides the placement found from the face. */
  placements?: Record<string, { x: number; y: number }>;
  /**
   * A closing keyword after the last phrase, held to the end of the last composed clip, with optional caption words
   * (interlocked under the keyword when they are three words or fewer and `interlock` is not off).
   */
  cta?: { keyword: string; caption?: string; fill?: TextFill };
  /** Word-timed transcripts by asset id (the route fills these in). */
  speech: Readonly<Record<string, readonly TranscriptWord[]>>;
  /** The presenter's face by asset id (the route fills these in from the identity gate). Absent: the reference's place. */
  faces?: Readonly<Record<string, FaceInput>>;
};

// ---------------------------------------------------------------- measured constants (reel 3)

/** Default keyword cap height: the median of reel 3's five keywords (7.5, 6.5, 8, 10, 9 %). */
export const KEYWORD_CAP = 0.085;
export const KEYWORD_CAP_MIN = 0.05;
export const KEYWORD_CAP_MAX = 0.14;
/** The keyword starts this long before it is said; reel 3's first visible frame is one frame (33 ms) ahead of the onset. */
export const KEYWORD_LEAD_MS = 40;
/** The keyword stays this long after the phrase's last word (reel 3 holds it to the cut at the sentence's end). */
export const KEYWORD_HOLD_MS = 250;
/** A caption word is cut on this long before it is said (the recipe's captionWord: onset − 40 ms). */
export const CAPTION_LEAD_MS = 40;
/** The last caption word of a phrase stays this long after it ends. */
export const CAPTION_HOLD_MS = 300;
/** Caption capitals (Archivo 600 at size 1 is about 2.75 % of the frame's height, the recipe's captionWord). */
export const CAPTION_SIZE = 1;
/** How much of the keyword's capitals the presenter's head covers (reel 3: "Before" 0.3, "difficult" 0.4). */
export const HEAD_OVER_CAPS = 0.35;
/** Hair above the face box the identity gate gives (forehead to chin), as a share of the face's height. */
const HAIR_OVER_FACE = 0.28;
/** A sentence longer than this is split at its commas: reel 3's lockups each last 1.5–2.6 s. */
export const PHRASE_SPLIT_MS = 2600;
/** A pause this long ends a phrase even without punctuation. */
const PHRASE_GAP_MS = 500;
/** Where a keyword sits when the face is not known: reel 3's keywords centre at y 0.32–0.43. */
const DEFAULT_KEYWORD_Y = 0.37;
/** The right edge of every lockup word: clear of Instagram's like/share column (x 960 px of 1080, the app's safe area). */
export const BUTTON_COLUMN_X = SAFE_AREA.right;
/** A little air inside the safe area's sides, so a serif's overhang and its shadow stay in. */
const AIR = 0.01;
/** The keyword face as the renderer draws it (look.ts: elegant at 0.7 of the 76 px base; Playfair weight 600). */
const ELEGANT_PX_PER_SIZE = 76 * 0.7;
const KEYWORD_WEIGHT = 600;
const KEYWORD_FONT = { fontFamily: "Playfair Display Variable", fontWeight: KEYWORD_WEIGHT, letterSpacing: 0.01 };
/**
 * Where Playfair's baseline sits below the centre of its line box at the elegant style's line-height of 1.2, in em
 * (hhea ascent 1.082, descent 0.251: half-leading −0.0665, baseline 1.0155 em from the top, the centre at 0.6).
 */
const BASELINE_BELOW_CENTRE_EM = 0.4155;

/*
 * The interlocked lockup (ADR 0089 addendum), measured on reel 3's "Before" + "you hire" (stills/DerRQWgo8yn-text-0.6.jpg,
 * 720x1280): "Before" capitals 95 px (7.4 %), top 460, baseline 555, x 150-537; "you hire" capitals about 31 px (2.4 %,
 * a third of the keyword's), their top at y 540 (15 px, 0.16 of the keyword's capitals, above the keyword's baseline),
 * its right edge at x 530, 7 px (0.02 of the keyword's width) in from the keyword's. The words said before a keyword
 * ("ask" over "yourself", "Do I" over "trust") sit over its top-left the same way.
 */
/** A phrase this short, keyword included, is interlocked; a longer one keeps the one-word caption track. */
export const INTERLOCK_MAX_WORDS = 4;
/** Companion capitals as a share of the keyword's ("you hire" 2.4 % under "Before" 7.4 %). */
export const COMPANION_CAP_RATIO = 0.33;
const COMPANION_CAP_MIN = 0.022;
const COMPANION_CAP_MAX = 0.04;
/** How far a line under the keyword reaches up into its capitals, as a share of the keyword's cap height. */
export const COMPANION_OVERLAP = 0.16;
/**
 * A line over the keyword sits on its cap line instead: reaching down into the capitals put it on the keyword's
 * ascenders ("Try it" on the f of "free" in the first local render) and it stopped reading; the ascenders still rise
 * beside it, so the two stay locked together.
 */
export const COMPANION_OVER_OVERLAP = 0;
/** A companion's edge sits this share of the keyword's width in from the keyword's edge. */
const COMPANION_INSET = 0.02;
/** A companion line wider than this many keyword widths does not interlock: it would stop reading as one block. */
const COMPANION_MAX_WIDTH_RATIO = 1.6;
/** Archivo's capitals in em (the caption track's size 1, 76 px, has capitals of about 52.8 px: 2.75 % of 1920). */
const ARCHIVO_CAP_EM = 0.695;
/** The plain style's px per size (look.ts BASE_TEXT_PX). */
const PLAIN_PX_PER_SIZE = 76;
/*
 * Glyph extents, measured from the bundled fonts at the weights drawn (fontTools on playfair-display-latin-wght-normal
 * at wght 600, archivo-latin-wdth-italic at wght 500 wdth 100): each glyph's top and bottom in em from the baseline.
 * Used to keep a companion line's ink off the keyword's (round-1 review: "Try" over "free" put the y's tail on the f;
 * round 2: Playfair's old-style figures 3 4 5 7 9 hang below the line and its $ rises above the ascenders). A keyword
 * or companion with a character not measured (an accented capital, a symbol) does not interlock: its extents are not
 * known, so the phrase keeps the caption track (round 3).
 */
type Ink = { glyphs: Map<string, [number, number]>; top: number; bottom: number };
const inkTable = (groups: [string, number, number][]): Ink => {
  const glyphs = new Map(groups.flatMap(([chars, top, bottom]) => [...chars].map((ch) => [ch, [top, bottom] as [number, number]] as const)));
  return { glyphs, top: Math.max(...groups.map((g) => g[1])), bottom: Math.min(...groups.map((g) => g[2])) };
};
const PLAYFAIR_INK = inkTable([
  ["$", 0.84, -0.132], ["%", 0.824, -0.055], ["()", 0.806, -0.182], ["bd", 0.783, -0.016], ["hkl", 0.783, 0], ["f!?", 0.782, -0.014],
  ["i", 0.772, 0], ["j", 0.772, -0.188], ["'\"‘’“”", 0.73, 0.45], ["6CGO8&/S", 0.723, -0.014], ["Q", 0.722, -0.188], ["A", 0.711, 0],
  ["BDEFHIKLPTXYZMNVWRU", 0.708, -0.014], ["J", 0.708, -0.188], ["t", 0.681, -0.014], ["@", 0.668, -0.161], ["+#", 0.606, 0.1],
  ["5", 0.559, -0.148], ["g", 0.541, -0.188], ["qp", 0.533, -0.181], ["aceos0mnr2:u1zwvx", 0.531, -0.014], ["3", 0.531, -0.151],
  ["4", 0.531, -0.141], ["9", 0.531, -0.15], [";", 0.53, -0.138], ["7", 0.521, -0.148], ["y", 0.517, -0.188], ["-", 0.307, 0.233],
  [",", 0.132, -0.138], [".", 0.132, -0.014],
]);
const ARCHIVO_ITALIC_INK = inkTable([
  ["()", 0.735, -0.157], ["/", 0.735, -0.049], ["f", 0.731, -0.182], ["bdhikl", 0.723, -0.012], ["j", 0.723, -0.182], ["$", 0.723, -0.049],
  ["CGOS03689%&#24?", 0.698, -0.012], ["Q", 0.698, -0.13], ["@", 0.698, -0.153], ["1ABDEFHIKLMNPRTVWXYZ7!JU5", 0.687, -0.012],
  ["'\"‘’“”", 0.686, 0.409], ["t", 0.673, -0.012], ["aceosmnruvwxz", 0.538, -0.012], ["g", 0.538, -0.182], ["pq", 0.538, -0.173],
  [":", 0.527, 0], [";", 0.527, -0.154], ["y", 0.526, -0.182], ["+", 0.511, 0], ["-", 0.32, 0.22], [",", 0.116, -0.154], [".", 0.116, 0],
]);
/** Clear space kept between a companion's ink and the keyword's, as a share of the companion's capitals. */
const INK_GAP = 0.25;
/** Whether every character of `text` has measured extents in both fonts (spaces have no ink). */
const measured = (text: string) => [...text].every((ch) => /\s/.test(ch) || (PLAYFAIR_INK.glyphs.has(ch) && ARCHIVO_ITALIC_INK.glyphs.has(ch)));
const inkTop = (ch: string, ink: Ink) => (/\s/.test(ch) ? 0 : ink.glyphs.get(ch)?.[0] ?? ink.top);
const inkBottom = (ch: string, ink: Ink) => (/\s/.test(ch) ? 0 : ink.glyphs.get(ch)?.[1] ?? ink.bottom);
/** The base of letters that sit on the line (a round letter's overshoot): below it, a tail is in the way. */
const ON_LINE = -0.016;

/**
 * The keyword's ink over a span of the frame (fractions): the highest top and lowest bottom, in em from its baseline,
 * of the letters whose advance falls in `[from, to]`. Without the keyword's text, the worst case.
 */
function keywordInkOver(keyword: { x: number; size: number; widthFraction: number; text?: string }, from: number, to: number): { top: number; bottom: number } {
  if (!keyword.text) return { top: PLAYFAIR_INK.top, bottom: PLAYFAIR_INK.bottom };
  const fontPx = keyword.size * ELEGANT_PX_PER_SIZE, W = REEL_FORMAT.width;
  const left = keyword.x - keyword.widthFraction / 2;
  let top = 0, bottom = 0;
  [...keyword.text].forEach((ch, i, chars) => {
    const x0 = left + estimateLineWidth(chars.slice(0, i).join(""), { ...KEYWORD_FONT, fontSize: fontPx }) / W;
    const x1 = left + estimateLineWidth(chars.slice(0, i + 1).join(""), { ...KEYWORD_FONT, fontSize: fontPx }) / W;
    if (x1 < from || x0 > to) return;
    top = Math.max(top, inkTop(ch, PLAYFAIR_INK));
    bottom = Math.min(bottom, inkBottom(ch, PLAYFAIR_INK));
  });
  return { top, bottom };
}

/** Companions are a lighter italic than the caption track's 600 (reel 3's companions are a regular italic). */
const COMPANION_WEIGHT = 500;
const COMPANION_FONT = { fontFamily: "Archivo Variable", fontWeight: COMPANION_WEIGHT };
/**
 * Where Archivo's capitals centre against its line box, in em above the box's centre (hhea ascent 0.878, descent 0.21:
 * the baseline 0.334 em below the centre, the capitals' middle 0.0135 em above it).
 */
const ARCHIVO_CAP_MID_ABOVE_CENTRE_EM = 0.0135;

// ---------------------------------------------------------------- phrases and keywords

export type Phrase = { words: SpokenWord[]; startMs: number; endMs: number };

/** A whisper token that is no word (a bracketed hallucination like `["The`, a lone quote). */
const noise = (word: string) => /[[\]{}]/.test(word) || normaliseWord(word) === "";

/**
 * A clip's speech cut into phrases: at a sentence's end (. ? ! or a 0.5 s pause), and a sentence longer than
 * PHRASE_SPLIT_MS also at its commas.
 */
export function phrasesOf(words: readonly SpokenWord[]): Phrase[] {
  const clean = words.filter((word) => !noise(word.text));
  const sentences: SpokenWord[][] = [];
  let current: SpokenWord[] = [];
  clean.forEach((word, i) => {
    if (current.length && word.startMs - clean[i - 1].endMs >= PHRASE_GAP_MS) { sentences.push(current); current = []; }
    current.push(word);
    if (/[.?!]["”']?$/.test(word.text)) { sentences.push(current); current = []; }
  });
  if (current.length) sentences.push(current);
  const phrases: SpokenWord[][] = [];
  for (const sentence of sentences) {
    const long = sentence[sentence.length - 1].endMs - sentence[0].startMs > PHRASE_SPLIT_MS;
    let part: SpokenWord[] = [];
    sentence.forEach((word, i) => {
      part.push(word);
      if (long && i < sentence.length - 1 && /[,;:—–]$/.test(word.text)) { phrases.push(part); part = []; }
    });
    if (part.length) phrases.push(part);
  }
  return phrases.map((list) => ({ words: list, startMs: list[0].startMs, endMs: list[list.length - 1].endMs }));
}

const STOPWORDS = new Set(("a an the to of on in at by for from with into onto over under up down out off about as and or but nor so yet if then than " +
  "i me my mine you your yours he him his she her hers it its we us our ours they them their theirs this that these those there here " +
  "is are was were be been being am do does did done's have has had having will would can could should shall may might must " +
  "not no just very really also too all any some each every what who whom which when where why how let lets let's get got " +
  "im i'm youre you're it's its' that's dont don't isnt isn't").split(/\s+/).map(normaliseWord));
// "done" is a stopword as an auxiliary but a strong closing word; it is let back in below.
STOPWORDS.delete("done");
const NUMBER_WORDS = new Set(["one", "once", "two", "twice", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "first", "hundred", "thousand", "million", "billion", "half", "double", "zero", "every"]);

/** The keyword stays this long or more in the reference (reel 3: 0.7–2.6 s from its onset to the cut); shorter reads as a flash. */
const KEYWORD_HOLD_GOAL_MS = 1500;

/**
 * The default keyword of a phrase: the content word that carries it. A number or a number word first (reel 2's
 * "16,000", "3x"), then a word said early enough to hold the screen while the rest of the phrase runs in the captions
 * (reel 3's keywords are first, second or mid-phrase and hold 0.7–2.6 s; a last word would flash on and off with the
 * cut), longer and more drawn-out words ahead of short quick ones. Null when every word is a function word.
 */
export function pickKeyword(phrase: Phrase): number | null {
  const durations = phrase.words.map((word) => Math.max(1, word.endMs - word.startMs) / Math.max(1, normaliseWord(word.text).length));
  const meanPace = durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length);
  let best: { index: number; score: number } | null = null;
  phrase.words.forEach((word, i) => {
    const norm = normaliseWord(word.text);
    if (!norm || STOPWORDS.has(norm)) return;
    let score = Math.min(1.2, norm.length * 0.15);
    if (/\d/.test(word.text) || NUMBER_WORDS.has(norm)) score += 1.5;
    score += 0.8 * Math.min(1, (phrase.endMs + KEYWORD_HOLD_MS - word.startMs) / KEYWORD_HOLD_GOAL_MS);
    // Drawn out (said more slowly than the phrase's average): emphasis.
    score += Math.max(0, Math.min(1, durations[i] / meanPace - 1));
    // A proper noun mid-sentence ("Utah", "Flinders").
    if (i > 0 && /^[A-Z]/.test(word.text) && !/[.?!]$/.test(phrase.words[i - 1].text)) score += 0.7;
    if (!best || score > best.score) best = { index: i, score };
  });
  return best === null ? null : (best as { index: number }).index;
}

/** A word as it is set: its spoken punctuation dropped except an apostrophe inside it ("listing," → "listing"). */
export function keywordText(word: string): string {
  return word.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "");
}

// ---------------------------------------------------------------- placement

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round4 = (v: number) => Number(v.toFixed(4));

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * The face box in composition fractions at `reelMs` (through the clip's fit, zoom and camera move then), or null. The
 * box is where the gate found the face on the take's first frame: a presenter take is a locked-off talking head.
 */
function faceOnScreen(timeline: Timeline, clipIndex: number, faces: LockupOptions["faces"], reelMs: number): Box | null {
  const clip = timeline.clips[clipIndex];
  const face = faces?.[clip.assetId];
  if (!face || !(face.width > 0 && face.height > 0)) return null;
  const at = onScreenAt(timeline, reelMs);
  const moment = at && at.index === clipIndex ? at.moment : { progress: 0, seconds: 0, opening: clipIndex === 0 };
  const picture = clipPicture(clip, { width: face.width, height: face.height }, moment);
  const [x0, y0] = sourceToComposition(picture, face.x0 * face.width, face.y0 * face.height);
  const [x1, y1] = sourceToComposition(picture, face.x1 * face.width, face.y1 * face.height);
  return { x0, y0, x1, y1 };
}

export type KeywordPlacement = { x: number; y: number; size: number; capHeight: number; widthFraction: number };

/**
 * Where a keyword goes and how big. Capitals `capHeight` of the frame tall, shrunk until the word fits between the
 * frame's left margin and the button column; centred on the face's x, its baseline set so the head (the face box plus
 * the hair above it) covers HEAD_OVER_CAPS of the capitals; never above the top 8 % or below y 0.72.
 */
export function placeKeyword(word: string, capHeight: number, face: { x0: number; y0: number; x1: number; y1: number } | null, at?: { x: number; y: number }): KeywordPlacement {
  const W = REEL_FORMAT.width, H = REEL_FORMAT.height;
  const room = (BUTTON_COLUMN_X - SAFE_AREA.left - 2 * AIR) * W;
  let cap = clamp(capHeight, KEYWORD_CAP_MIN, KEYWORD_CAP_MAX);
  const widthAt = (c: number) => estimateLineWidth(word, { ...KEYWORD_FONT, fontSize: (c * H) / SERIF_CAP_EM });
  if (widthAt(cap) > room) cap = Math.max(KEYWORD_CAP_MIN * 0.6, (cap * room) / widthAt(cap));
  const fontPx = (cap * H) / SERIF_CAP_EM;
  const size = Math.min(KEYWORD_SIZE_MAX, fontPx / ELEGANT_PX_PER_SIZE);
  const half = widthAt(cap) / 2 / W;
  const fitX = (x: number) => clamp(x, SAFE_AREA.left + AIR + half, BUTTON_COLUMN_X - AIR - half);
  // The line box's centre: the capitals' top stays under Instagram's header, its bottom above the caption zone.
  const fitY = (y: number) => clamp(y, SAFE_AREA.top + 0.75 * cap, TEXT_SAFE_BOTTOM - cap);
  if (at) return { x: round4(fitX(at.x)), y: round4(fitY(at.y)), size: round4(size), capHeight: round4(cap), widthFraction: round4(half * 2) };
  if (!face) return { x: round4(fitX(0.5)), y: round4(fitY(DEFAULT_KEYWORD_Y)), size: round4(size), capHeight: round4(cap), widthFraction: round4(half * 2) };
  const headTop = face.y0 - HAIR_OVER_FACE * (face.y1 - face.y0);
  const baseline = headTop + HEAD_OVER_CAPS * cap;
  const centreY = baseline - BASELINE_BELOW_CENTRE_EM * (fontPx / H);
  return { x: round4(fitX((face.x0 + face.x1) / 2)), y: round4(fitY(centreY)), size: round4(size), capHeight: round4(cap), widthFraction: round4(half * 2) };
}

/** The caption track's centre: under the chin (reel 3 sets its captions on her chest), above y 0.72, off the buttons. */
export function placeCaptions(face: { x0: number; y0: number; x1: number; y1: number } | null): { x: number; y: number } {
  if (!face) return { x: 0.5, y: 0.52 };
  const below = face.y1 + 0.35 * (face.y1 - face.y0);
  return { x: round4(clamp((face.x0 + face.x1) / 2, 0.22, BUTTON_COLUMN_X - 0.2)), y: round4(clamp(below, 0.3, TEXT_SAFE_BOTTOM - 0.03)) };
}

export type CompanionPlacement = { text: string; position: "over" | "under"; x: number; y: number; size: number; capHeight: number; widthFraction: number };

/**
 * The companions of an interlocked keyword (ADR 0089 addendum): the words before the keyword as one line over its
 * top-left, the words after it as one line under its right half, each with capitals COMPANION_CAP_RATIO of the
 * keyword's; the line under reaches COMPANION_OVERLAP of the keyword's capitals up into it, the line over sits on its cap
 * line. Null when they do not fit as one block
 * (a line wider than the keyword allows, or one that would leave the safe area): the caption track is used instead.
 */
export function placeCompanions(keyword: { x: number; y: number; size: number; widthFraction: number; text?: string }, before: string, after: string): CompanionPlacement[] | null {
  const W = REEL_FORMAT.width, H = REEL_FORMAT.height;
  const fontPx = keyword.size * ELEGANT_PX_PER_SIZE;
  const cap = (fontPx * SERIF_CAP_EM) / H;
  const baseline = keyword.y + (BASELINE_BELOW_CENTRE_EM * fontPx) / H;
  const capTop = baseline - cap;
  const left = keyword.x - keyword.widthFraction / 2, right = keyword.x + keyword.widthFraction / 2;
  const c = clamp(COMPANION_CAP_RATIO * cap, COMPANION_CAP_MIN, COMPANION_CAP_MAX);
  const px = (c * H) / ARCHIVO_CAP_EM;
  const size = px / PLAIN_PX_PER_SIZE;
  const roomLeft = SAFE_AREA.left + AIR, roomRight = BUTTON_COLUMN_X - AIR;
  const maxWidth = Math.min(roomRight - roomLeft, Math.max(keyword.widthFraction, 0.18) * COMPANION_MAX_WIDTH_RATIO);
  const inset = COMPANION_INSET * keyword.widthFraction;
  // Only glyphs whose ink was measured can be kept clear of each other; anything else keeps the caption track.
  if (!measured(`${keyword.text ?? ""}${before}${after}`)) return null;
  const placed: CompanionPlacement[] = [];
  for (const [text, position] of [[before, "over"], [after, "under"]] as const) {
    if (!text) continue;
    // Italic leans right a little past its advances: an em-twentieth of air.
    const width = (estimateLineWidth(text, { ...COMPANION_FONT, fontSize: px }) + 0.05 * px) / W;
    if (width > maxWidth) return null;
    // Over: left-aligned in from the keyword's left edge, its baseline inside the top of the capitals.
    // Under: right-aligned in from the keyword's right edge, its capitals' top inside the bottom of the capitals.
    const x = position === "over" ? left + inset + width / 2 : right - inset - width / 2;
    let capMid = position === "over" ? capTop + COMPANION_OVER_OVERLAP * cap - c / 2 : baseline - COMPANION_OVERLAP * cap + c / 2;
    // Ink never touches ink: the keyword's letters under the line (an ascender, a tail) and the line's own (a tail, a
    // tall italic f) are measured, and the line moves clear by a quarter of its capitals.
    const ink = keywordInkOver(keyword, x - width / 2, x + width / 2);
    const em = px / H, kwEm = fontPx / H, gap = INK_GAP * c;
    const chars = [...text];
    if (position === "over") {
      const ownBottom = Math.min(0, ...chars.map((ch) => inkBottom(ch, ARCHIVO_ITALIC_INK))) * em;
      const highest = baseline - ink.top * kwEm - gap + ownBottom;
      capMid = Math.min(capMid, highest - c / 2);
    } else {
      const ownTop = Math.max(...chars.map((ch) => inkTop(ch, ARCHIVO_ITALIC_INK))) * em;
      // Tucked into the capitals by design (reel 3); only a tail of the keyword in the line's way pushes it down below it.
      if (ink.bottom < ON_LINE) capMid = Math.max(capMid, baseline - ink.bottom * kwEm + gap + ownTop - c / 2);
    }
    const y = capMid + (ARCHIVO_CAP_MID_ABOVE_CENTRE_EM * px) / H;
    // The line's own box (about 1.2 em tall) inside the safe area, or it does not interlock.
    const halfBox = (0.6 * px) / H;
    if (y - halfBox < SAFE_AREA.top || y + halfBox > TEXT_SAFE_BOTTOM) return null;
    placed.push({ text, position, x: round4(clamp(x, roomLeft + width / 2, roomRight - width / 2)), y: round4(y), size: round4(size), capHeight: round4(c), widthFraction: round4(width) });
  }
  return placed;
}

// ---------------------------------------------------------------- composing

export type LockupReport = {
  lockupId: string; clipId: string; phrase: string; keyword: string | null; startMs: number; endMs: number; keywordAt?: { x: number; y: number; capHeight: number };
  /** "interlock": the other words are companions tucked into the keyword; "captions": the one-word caption track. */
  layout: "interlock" | "captions";
  captions: string[]; captionAt?: { x: number; y: number };
  companions?: { text: string; x: number; y: number; capHeight: number }[];
};

/** A lockup's id: the clip's whole id and the phrase's number, so two clips never share one (ids like `script-ai-…` share long prefixes). */
const lockupIdFor = (clipId: string, n: number) => `${clipId}-${n}`;
/** Whether a lockup was made on this clip: its id is the clip's id, a dash and a number (not merely a prefix: clip "a" is not clip "a-b"). */
const onClip = (lockupId: string, clipId: string) => lockupId.startsWith(`${clipId}-`) && /^\d+$/.test(lockupId.slice(clipId.length + 1));

/**
 * One companion line as a title: its words arrive as they are said (`wordsMs`, kinetic "words": each fades up out of a
 * small blur, building the line), and it leaves with the keyword. In front of the presenter, so her hair never eats a
 * small word (reel 3 loses the "y" of "you hire" behind hers); the keyword stays behind her.
 */
function companionTitle(id: string, placed: CompanionPlacement, startMs: number, endMs: number, wordsMs: number[]): TextOverlay {
  return textSchema.parse({
    id: `kp-${placed.position}-${id}`, text: placed.text, startMs, endMs, x: placed.x, y: placed.y, style: "plain", size: placed.size, color: "#ffffff",
    weight: COMPANION_WEIGHT, italic: true, shadow: "soft", animation: "blurQuick", byApp: true, lockup: { id, role: "companion" },
    kinetic: { preset: "words", startMs: 0, durationMs: Math.max(100, Math.min(10_000, endMs - startMs)), wordsMs },
  });
}

/** The timeline with keyword lockups on the chosen clips (any earlier lockups on them replaced). Throws a plain error when there is nothing to compose. */
export function composeKeywordLockups(timeline: Timeline, options: LockupOptions): Timeline {
  const starts = clipStartsMs(timeline);
  const wanted = options.clipIds?.length ? options.clipIds : timeline.clips.map((clip) => clip.id);
  for (const id of wanted) if (!timeline.clips.some((clip) => clip.id === id)) throw new Error(`There is no clip called ${id} in the reel.`);
  const capHeight = options.capHeight ?? KEYWORD_CAP;
  const listed = new Map((options.keywords ?? []).map((word) => [normaliseWord(word), word] as const));
  const placements = new Map(Object.entries(options.placements ?? {}).map(([word, at]) => [normaliseWord(word), at] as const));
  const added: TextOverlay[] = [];
  const touched = new Set<string>();
  let lastClip: { index: number; endMs: number; face: Box | null; lastEnd: number } | null = null;

  timeline.clips.forEach((clip, index) => {
    if (!wanted.includes(clip.id)) return;
    const spoken = spokenWordsOfClip(timeline, index, options.speech);
    const clipStart = starts[index], clipEnd = clipStart + clipDurationMs(clip);
    const phrases = phrasesOf(spoken).filter((phrase) => phrase.startMs < clipEnd - 100);
    if (!phrases.length) return;
    touched.add(clip.id);
    phrases.forEach((phrase, n) => {
      // The face where it is when the phrase starts (an opening scale-out or a push moves it).
      const face = faceOnScreen(timeline, index, options.faces, Math.max(clipStart, phrase.startMs));
      const captionAt = placeCaptions(face);
      const nextStart = n + 1 < phrases.length ? phrases[n + 1].startMs : clipEnd;
      const id = lockupIdFor(clip.id, n);
      let k = phrase.words.findIndex((word) => listed.has(normaliseWord(word.text)));
      if (k < 0) k = options.keywordsOnly ? -1 : (pickKeyword(phrase) ?? -1);
      const phraseEnd = Math.min(clipEnd, Math.max(phrase.endMs + KEYWORD_HOLD_MS, phrase.startMs + 600), nextStart - CAPTION_LEAD_MS);
      if (k >= 0) {
        // A listed keyword is set as it was written (whisper capitalises at random: "Listing" mid-sentence).
        const word = listed.get(normaliseWord(phrase.words[k].text))?.trim() || keywordText(phrase.words[k].text);
        const at = placements.get(normaliseWord(word));
        const placed = placeKeyword(word, capHeight, face, at);
        const startMs = Math.max(clipStart, phrase.words[k].startMs - KEYWORD_LEAD_MS);
        // Too short to read before the clip ends: no keyword, and the word goes back into the captions.
        if (phraseEnd - startMs < 300) k = -1;
        else {
          added.push(textSchema.parse({
            id: `kw-${id}`, text: word, startMs, endMs: phraseEnd, x: placed.x, y: placed.y, style: "elegant", size: placed.size, color: options.color ?? "#ffffff",
            weight: KEYWORD_WEIGHT, shadow: "soft", animation: "blurQuick", behind: true, byApp: true, lockup: { id, role: "keyword" },
            ...(options.fill ? { fill: options.fill } : {}),
          }));
          // A short phrase interlocks: its other words are tucked into the keyword's block (ADR 0089 addendum).
          if (options.interlock !== false && options.captions !== false && phrase.words.length > 1 && phrase.words.length <= INTERLOCK_MAX_WORDS) {
            const setAs = (list: SpokenWord[]) => list.map((w) => keywordText(w.text) || w.text).join(" ");
            const before = phrase.words.slice(0, k), after = phrase.words.slice(k + 1);
            const companions = placeCompanions({ ...placed, text: word }, setAs(before), setAs(after));
            const lines = (companions ?? []).map((line) => {
              const words = line.position === "over" ? before : after;
              return { line, words, lineStart: Math.max(clipStart, words[0].startMs - CAPTION_LEAD_MS) };
            });
            // Every companion is readable (on 200 ms or more) or none is: a word too late to show keeps the caption track,
            // so no spoken word is dropped (round-1 review).
            if (companions && lines.every(({ lineStart }) => phraseEnd - lineStart >= 200)) {
              for (const { line, words, lineStart } of lines) {
                const wordsMs = words.map((w) => Math.max(0, Math.round(w.startMs - CAPTION_LEAD_MS - lineStart)));
                added.push(companionTitle(id, line, lineStart, phraseEnd, wordsMs));
              }
              return;
            }
          }
        }
      }
      if (options.captions === false) return;
      const companions = phrase.words.map((word, i) => ({ word, i })).filter(({ i }) => i !== k);
      if (!companions.length) return;
      const startMs = Math.max(clipStart, companions[0].word.startMs - CAPTION_LEAD_MS);
      const endMs = Math.min(clipEnd, nextStart - CAPTION_LEAD_MS, Math.max(companions[companions.length - 1].word.endMs + CAPTION_HOLD_MS, startMs + 300));
      if (endMs - startMs < 200) return;
      // Each word on 40 ms ahead of being said; off when the keyword is said (the big word takes over), else replaced by the next.
      const wordsMs = companions.map(({ word }) => Math.max(0, Math.round(word.startMs - CAPTION_LEAD_MS - startMs)));
      const wordsOffMs = companions.map(({ word, i }, j) => {
        const next = companions[j + 1];
        if (k > i && (!next || next.i > k)) return Math.max(wordsMs[j] + 1, Math.round(phrase.words[k].startMs - CAPTION_LEAD_MS - startMs));
        if (!next) return Math.round(endMs - startMs);
        // A pause inside the phrase: the word goes after its hold rather than sitting through the silence.
        return Math.max(wordsMs[j] + 1, Math.min(wordsMs[j + 1], Math.round(word.endMs + CAPTION_HOLD_MS - startMs)));
      });
      added.push(textSchema.parse({
        id: `kc-${id}`, text: companions.map(({ word }) => keywordText(word.text) || word.text).join(" "), startMs, endMs, x: captionAt.x, y: captionAt.y,
        style: "plain", size: CAPTION_SIZE, color: "#ffffff", shadow: "soft", italic: true, animation: "none", byApp: true, lockup: { id, role: "captions" },
        kinetic: { preset: "caption", startMs: 0, durationMs: Math.max(100, endMs - startMs), wordsMs, wordsOffMs },
      }));
    });
    lastClip = { index, endMs: clipEnd, face: faceOnScreen(timeline, index, options.faces, Math.max(clipStart, clipEnd - 500)), lastEnd: phrases[phrases.length - 1].endMs };
  });
  if (!touched.size) throw new Error("None of those clips has transcribed speech, so there are no words to set. A voiced take is transcribed when it is made; an upload, a few seconds after it is added.");

  const close = lastClip as { index: number; endMs: number; face: Box | null; lastEnd: number } | null;
  if (options.cta && close) {
    const id = `${lockupIdFor(timeline.clips[close.index].id, 99)}`;
    // The closer takes over when the last phrase's lockup (its keyword and its captions) has gone.
    const shown = added.filter((text) => text.endMs <= close.endMs).map((text) => text.endMs);
    const startMs = Math.max(shown.length ? Math.max(...shown) : close.lastEnd, close.endMs - 4000);
    if (close.endMs - startMs < 500) throw new Error("There is no time after the last phrase for a closing keyword: the last clip ends as she finishes speaking.");
    const word = options.cta.keyword.trim();
    const placed = placeKeyword(word, capHeight, close.face, placements.get(normaliseWord(word)));
    added.push(textSchema.parse({
      id: `kw-${id}`, text: word, startMs, endMs: close.endMs, x: placed.x, y: placed.y, style: "elegant", size: placed.size, color: options.color ?? "#ffffff",
      weight: KEYWORD_WEIGHT, shadow: "soft", animation: "blurQuick", behind: true, byApp: true, lockup: { id, role: "keyword" },
      ...(options.cta.fill ?? options.fill ? { fill: options.cta.fill ?? options.fill } : {}),
    }));
    const caption = options.cta.caption?.trim();
    // A short closing line interlocks under the keyword, its words following at a speaking pace once the keyword has landed.
    const tucked = caption && options.interlock !== false && caption.split(/\s+/).length < INTERLOCK_MAX_WORDS ? placeCompanions({ ...placed, text: word }, "", caption) : null;
    if (caption && tucked?.length) {
      const span = close.endMs - startMs;
      const wordsMs = caption.split(/\s+/).map((_, i) => Math.min(span - 100, 250 + i * 300));
      added.push(companionTitle(id, tucked[0], startMs, close.endMs, wordsMs));
    } else if (caption) {
      const at = placeCaptions(close.face);
      const words = caption.split(/\s+/);
      const span = close.endMs - startMs;
      // Read after the keyword lands: the words follow at a speaking pace (about 300 ms each), the last one held to the end.
      const wordsMs = words.map((_, i) => Math.min(span - 100, 250 + i * 300));
      added.push(textSchema.parse({
        id: `kc-${id}`, text: caption, startMs, endMs: close.endMs, x: at.x, y: at.y, style: "plain", size: CAPTION_SIZE, color: "#ffffff", shadow: "soft", italic: true,
        animation: "none", byApp: true, lockup: { id, role: "captions" }, kinetic: { preset: "caption", startMs: 0, durationMs: Math.max(100, span), wordsMs },
      }));
    }
  }
  // Lockups on the composed clips are replaced; everything else (other titles, other clips' lockups) is kept.
  const ours = (text: TextOverlay) => text.lockup && [...touched].some((clipId) => onClip(text.lockup!.id, clipId));
  return { ...timeline, texts: [...timeline.texts.filter((text) => !ours(text)), ...added] };
}

/** Every lockup on the timeline, for a dry run: the phrase's keyword and where it sits, and its caption words. */
export function describeLockups(timeline: Timeline): LockupReport[] {
  const starts = clipStartsMs(timeline);
  const groups = new Map<string, TextOverlay[]>();
  for (const text of timeline.texts) if (text.lockup) groups.set(text.lockup.id, [...(groups.get(text.lockup.id) ?? []), text]);
  return [...groups.entries()].map(([lockupId, texts]) => {
    const keyword = texts.find((text) => text.lockup!.role === "keyword");
    const captions = texts.find((text) => text.lockup!.role === "captions");
    // Companions in reading order: the line over the keyword, then the line under it.
    const companions = texts.filter((text) => text.lockup!.role === "companion").sort((a, b) => a.y - b.y);
    const over = companions.filter((text) => keyword && text.y < keyword.y), under = companions.filter((text) => !over.includes(text));
    const startMs = Math.min(...texts.map((text) => text.startMs)), endMs = Math.max(...texts.map((text) => text.endMs));
    const clipIndex = timeline.clips.findIndex((clip, i) => startMs >= starts[i] && startMs < starts[i] + clipDurationMs(clip));
    const capHeight = keyword ? round4((keyword.size * ELEGANT_PX_PER_SIZE * SERIF_CAP_EM) / REEL_FORMAT.height) : 0;
    return {
      lockupId, clipId: timeline.clips[clipIndex]?.id ?? "",
      phrase: (companions.length ? [...over.map((t) => t.text), keyword?.text, ...under.map((t) => t.text)] : [captions?.text, keyword?.text]).filter(Boolean).join(" / "),
      keyword: keyword?.text ?? null, startMs, endMs,
      ...(keyword ? { keywordAt: { x: keyword.x, y: keyword.y, capHeight } } : {}),
      layout: companions.length ? ("interlock" as const) : ("captions" as const),
      captions: captions ? captions.text.split(/\s+/) : [],
      ...(captions ? { captionAt: { x: captions.x, y: captions.y } } : {}),
      ...(companions.length ? { companions: companions.map((t) => ({ text: t.text, x: t.x, y: t.y, capHeight: round4((t.size * PLAIN_PX_PER_SIZE * ARCHIVO_CAP_EM) / REEL_FORMAT.height) })) } : {}),
    };
  });
}
