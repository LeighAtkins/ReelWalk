import type { Transcript, TranscriptWord } from "./transcript";

/**
 * Auto-trim of a voiced take to its line (ADR 0069). Veo adds a garbled tail
 * after the line ("Send it, settle it, tune back into Hiker's List") and
 * sometimes a pause before it; agents trimmed by whisper word timings by
 * hand. Here the line's words are aligned to the words heard, the trim is
 * set around the matched span, and a take whose heard words stray too far
 * from the line is flagged as "wrong words".
 */
export const TRIM_LEAD_MS = 150;
export const TRIM_TAIL_MS = 250;
/** Normalised word edit distance above which the take did not say its line. */
export const WRONG_WORDS_THRESHOLD = 0.15;

/** Lowercase words with punctuation removed; "it's" becomes "its", "1974" stays. */
export function normaliseWords(text: string): string[] {
  return text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

/** Character edit distance, for spelling drift between the line and the recogniser ("cosy" and "cozy"). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return previous[b.length];
}

/** Two words are the same word when they differ by at most one letter in four (one letter under eight). */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  return levenshtein(a, b) <= Math.max(1, Math.floor(longest / 4));
}

export type LineAlignment = {
  /** Indexes into the heard words: the first and last heard word that belong to the line. */
  first: number; last: number;
  /** Line words matched to a heard word. */
  matched: number;
  /** Edits (missed, extra or substituted words) inside the span, over the line's length. */
  distance: number;
};

/**
 * Where the line sits in the words heard: a semi-global alignment (the heard
 * words before and after the line are free, so a tail Veo added costs
 * nothing), with substitutions, missed and extra words each costing one.
 * Null when nothing was heard.
 */
export function alignLine(line: string[], heard: string[]): LineAlignment | null {
  const n = line.length, m = heard.length;
  if (!n || !m) return null;
  // cost[i][j]: aligning line[0..i) ending anywhere up to heard[j); the start on the heard side is free.
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const from: ("diag" | "up" | "left" | "start")[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill("start"));
  for (let i = 1; i <= n; i++) { cost[i][0] = i; from[i][0] = "up"; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = cost[i - 1][j - 1] + (wordsMatch(line[i - 1], heard[j - 1]) ? 0 : 1);
      const up = cost[i - 1][j] + 1, left = cost[i][j - 1] + 1;
      const best = Math.min(diag, up, left);
      cost[i][j] = best;
      from[i][j] = best === diag ? "diag" : best === up ? "up" : "left";
    }
  }
  // Free end: the cheapest column of the last row, preferring the earliest so a repeated phrase in the tail is not chosen.
  let end = 0;
  for (let j = 1; j <= m; j++) if (cost[n][j] < cost[n][end]) end = j;
  // Trace back to the first heard word the line touched.
  let i = n, j = end, first = -1, last = -1, matched = 0;
  while (i > 0 && j > 0) {
    const step = from[i][j];
    if (step === "diag") {
      if (wordsMatch(line[i - 1], heard[j - 1])) { matched += 1; if (last < 0) last = j - 1; first = j - 1; }
      else { if (last < 0) last = j - 1; first = j - 1; }
      i -= 1; j -= 1;
    } else if (step === "up") i -= 1;
    else j -= 1;
  }
  if (first < 0) return { first: 0, last: m - 1, matched: 0, distance: 1 };
  return { first, last, matched, distance: Math.min(1, cost[n][end] / n) };
}

export type TakeTrim = {
  /** The line the take was asked to say. */
  line: string;
  /** The source window that holds the line: first word less the lead, last word plus the tail, inside the file. */
  startMs: number; endMs: number;
  /** The heard words inside that window. */
  heard: string;
  /** How far the heard words stray from the line (0 exact, 1 nothing matched). */
  distance: number;
  /** The take did not say its line (distance over the threshold). */
  wrongWords: boolean;
};

/**
 * The trim for a voiced take from its word-timed transcript. With no words
 * heard the whole take is kept and flagged. A tail Veo added after the line
 * is outside the window; words of the line that were not heard count
 * against it.
 */
export function lineTrim(transcript: Pick<Transcript, "words"> | null | undefined, line: string, durationMs: number): TakeTrim {
  const words: TranscriptWord[] = transcript?.words ?? [];
  const lineWords = normaliseWords(line);
  const heardWords = words.map(word => normaliseWords(word.w).join("")).map(w => w || "-");
  const alignment = alignLine(lineWords, heardWords);
  if (!alignment || !words.length) return { line, startMs: 0, endMs: Math.max(0, Math.round(durationMs)), heard: "", distance: 1, wrongWords: true };
  const span = words.slice(alignment.first, alignment.last + 1);
  const startMs = Math.max(0, span[0].s - TRIM_LEAD_MS);
  const endMs = Math.min(Math.max(0, Math.round(durationMs)) || Number.MAX_SAFE_INTEGER, span[span.length - 1].e + TRIM_TAIL_MS);
  return {
    line, startMs, endMs: Math.max(endMs, startMs + 1), heard: span.map(word => word.w).join(" "),
    distance: Math.round(alignment.distance * 100) / 100, wrongWords: alignment.distance > WRONG_WORDS_THRESHOLD,
  };
}
