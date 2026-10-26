/**
 * Word starts put back on the voice (ADR 0089 round 3). Whisper's word times come from its attention, not from the
 * audio, and on a Veo take that opens on room tone they drift: on the round-2 pier take whisper-small put "Before" at
 * 1.08 s when the voice starts at 0.80 s, and set "list," inside a 450 ms pause. A keyword lockup arrives on its word's
 * onset, so a quarter-second error is a visible late title.
 *
 * Pure: the audio's loudness per 10 ms frame in, voiced stretches out, and each phrase's first word (and any word
 * that starts in a silence) moved to where the voice actually starts. A word is never moved more than 1.2 s, or before
 * the word ahead of it.
 */
import type { TranscriptWord } from "./transcript";

/** Loudness frames, ms. */
export const LEVEL_FRAME_MS = 10;
/** A gap in the voice this short is inside a word (a stop consonant, a breath between syllables). */
const BRIDGE_MS = 150;
/** A voiced stretch shorter than this is a click, not speech. */
const MIN_VOICED_MS = 80;
/** A word whisper set this long after the last one ended starts a phrase. */
const PHRASE_GAP_MS = 150;
/** The furthest a word start is moved. */
const MAX_SHIFT_MS = 1200;

export type Voiced = { startMs: number; endMs: number };

/** RMS loudness in dB (full scale) of each `frameMs` frame of mono samples in −1…1. */
export function levelsDb(samples: ArrayLike<number>, sampleRate: number, frameMs = LEVEL_FRAME_MS): number[] {
  const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const levels: number[] = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += samples[i] * samples[i];
    levels.push(10 * Math.log10(sum / size + 1e-12));
  }
  return levels;
}

const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
};

/**
 * The voiced stretches: frames 10 dB over the quiet floor (the 20th percentile) and no more than 30 dB under the loud
 * peaks (the 98th), gaps up to 150 ms bridged, stretches under 80 ms dropped. Empty for a flat or silent track.
 */
export function voicedStretches(levels: readonly number[], frameMs = LEVEL_FRAME_MS): Voiced[] {
  if (levels.length < 10) return [];
  const floor = percentile(levels, 0.2), peak = percentile(levels, 0.98);
  if (peak - floor < 12) return [];
  const threshold = Math.max(floor + 10, peak - 30);
  const stretches: Voiced[] = [];
  levels.forEach((level, i) => {
    if (level < threshold) return;
    const startMs = i * frameMs, endMs = (i + 1) * frameMs;
    const last = stretches[stretches.length - 1];
    if (last && startMs - last.endMs <= BRIDGE_MS) last.endMs = endMs;
    else stretches.push({ startMs, endMs });
  });
  return stretches.filter((s) => s.endMs - s.startMs >= MIN_VOICED_MS);
}

/**
 * The words with their starts on the voice. Whisper is off by about the same amount through a phrase (on the pier take
 * all three of "Before you list," were 0.25 s late), so a phrase's first word (the first, one after a pause in whisper's
 * times, or one after punctuation) inside a voiced stretch moves back to where that stretch starts, and the rest of its
 * phrase moves by the same amount. A word that then still starts in a silence moves forward to the next stretch. Ends
 * move only to stay after their starts. Order is kept.
 */
export function snapWordsToVoice(words: readonly TranscriptWord[], voiced: readonly Voiced[]): TranscriptWord[] {
  if (!voiced.length) return words.map((word) => ({ ...word }));
  const out: TranscriptWord[] = [];
  const voicedAt = (ms: number) => voiced.find((v) => ms >= v.startMs && ms < v.endMs);
  let shift = 0;
  words.forEach((word, i) => {
    const before = out[i - 1];
    const floor = before ? before.s + 1 : 0;
    const phraseStart = i === 0 || word.s - words[i - 1].e >= PHRASE_GAP_MS || /[.?!,;:]["”']?$/.test(words[i - 1].w);
    let s = word.s;
    if (phraseStart) {
      const inside = voicedAt(word.s);
      shift = inside && inside.startMs >= floor && word.s - inside.startMs <= MAX_SHIFT_MS ? inside.startMs - word.s : 0;
    }
    s = word.s + shift;
    if (!voicedAt(s)) {
      const next = voiced.find((v) => v.startMs > s);
      if (next && next.startMs - s <= MAX_SHIFT_MS && (i + 1 >= words.length || next.startMs < words[i + 1].e + shift)) s = next.startMs;
    }
    s = Math.max(s, floor);
    const e = Math.max(word.e + Math.min(0, shift), s + Math.min(200, Math.max(40, word.e - word.s)));
    out.push({ w: word.w, s: Math.round(s), e: Math.round(e) });
  });
  return out;
}
