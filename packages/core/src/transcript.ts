import { z } from "zod";
import type { Clip } from "./timeline";

/**
 * What a video says, measured from its audio by the worker when it is
 * uploaded (speech recognition with word timings). Times are milliseconds
 * from the start of the source file, like clip.sourceStartMs.
 *
 * The editor and the model use it to put captions on the words that are
 * spoken, instead of guessing, and to know which clips carry a voice.
 */
export const transcriptWordSchema = z.object({
  w: z.string().min(1).max(60),
  s: z.number().int().nonnegative(),
  e: z.number().int().nonnegative(),
});
/** For a voiced AI take (ADR 0069): the line it was asked to say, where that line sits in the file, and whether it said it. */
export const takeTrimSchema = z.object({
  line: z.string().max(200),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  heard: z.string().max(400),
  distance: z.number().min(0).max(1),
  wrongWords: z.boolean(),
});
export const transcriptSchema = z.object({
  text: z.string().max(4000),
  words: z.array(transcriptWordSchema).max(2000),
  language: z.string().max(12).optional(),
  model: z.string().max(80).optional(),
  take: takeTrimSchema.optional(),
});
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;

export type SpeechPhrase = { text: string; startMs: number; endMs: number };

export const hasSpeech = (transcript: Transcript | null | undefined): transcript is Transcript =>
  Boolean(transcript && transcript.words.length > 0);

/** The words heard inside a source window: at least 100 ms of the word (or half of a shorter one) plays. */
export function transcriptWindow(transcript: Transcript, startMs: number, endMs: number): TranscriptWord[] {
  return transcript.words.filter((word) => {
    const overlap = Math.min(word.e, endMs) - Math.max(word.s, startMs);
    return overlap > 0 && overlap >= Math.min(100, (word.e - word.s) / 2);
  });
}

const BREAK_BEFORE = new Set(["and", "but", "or", "so", "then", "while", "because"]);
const ENDS_PHRASE = /[.!?;:]["')]?$/;

/**
 * Groups words into caption-sized phrases: a phrase ends at sentence
 * punctuation, before a joining word once it has two words, at a pause, or
 * when it would run past `maxWords` or `maxMs`.
 */
export function speechPhrases(
  words: TranscriptWord[],
  { maxWords = 5, maxMs = 3000, gapMs = 600 }: { maxWords?: number; maxMs?: number; gapMs?: number } = {},
): SpeechPhrase[] {
  const phrases: SpeechPhrase[] = [];
  let current: TranscriptWord[] = [];
  const flush = () => {
    if (!current.length) return;
    phrases.push({ text: current.map((word) => word.w).join(" "), startMs: current[0].s, endMs: current[current.length - 1].e });
    current = [];
  };
  for (const word of words) {
    const last = current[current.length - 1];
    if (last) {
      const paused = word.s - last.e > gapMs;
      const tooLong = current.length >= maxWords || word.e - current[0].s > maxMs;
      const joiner = current.length >= 2 && BREAK_BEFORE.has(word.w.toLowerCase().replace(/[^a-z']/g, ""));
      if (paused || tooLong || joiner) flush();
    }
    current.push(word);
    if (ENDS_PHRASE.test(word.w)) flush();
  }
  flush();
  return phrases;
}

/** Source milliseconds of a clip to reel milliseconds, given where the clip starts in the reel. */
export function sourceToReelMs(clip: Clip, clipStartMs: number, sourceMs: number): number {
  return clipStartMs + Math.round((sourceMs - clip.sourceStartMs) / (clip.speed || 1));
}

/**
 * Captions for the speech a clip plays, in reel time. Each phrase shows from
 * its first word to its last (at least `minHoldMs`), ends before the next
 * phrase starts, and never runs past the clip's end.
 */
export function captionsFromSpeech(transcript: Transcript, clip: Clip, clipStartMs: number, minHoldMs = 700): SpeechPhrase[] {
  const words = transcriptWindow(transcript, clip.sourceStartMs, clip.sourceEndMs);
  const phrases = speechPhrases(words);
  const clipEndMs = sourceToReelMs(clip, clipStartMs, clip.sourceEndMs);
  return phrases
    .map((phrase, index) => {
      const startMs = Math.max(clipStartMs, sourceToReelMs(clip, clipStartMs, phrase.startMs));
      const next = phrases[index + 1] ? sourceToReelMs(clip, clipStartMs, phrases[index + 1].startMs) : clipEndMs;
      const endMs = Math.min(clipEndMs, Math.max(sourceToReelMs(clip, clipStartMs, phrase.endMs), startMs + minHoldMs, 0), next);
      return { text: phrase.text, startMs, endMs };
    })
    .filter((phrase) => phrase.endMs > phrase.startMs);
}

/** One line for the reel description: what the clip says and when, measured from the clip's start as played. */
export function describeSpeech(transcript: Transcript, clip: Clip): string | null {
  const phrases = captionsFromSpeech(transcript, clip, 0);
  if (!phrases.length) return null;
  const seconds = (value: number) => (value / 1000).toFixed(1);
  const shown = phrases.slice(0, 12).map((phrase) => `${seconds(phrase.startMs)}–${seconds(phrase.endMs)} s "${phrase.text}"`);
  if (phrases.length > 12) shown.push(`and ${phrases.length - 12} more`);
  return `${clip.volume > 0 ? "says" : "says (muted)"}: ${shown.join(", ")}`;
}
