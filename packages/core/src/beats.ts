import { clipDurationMs, MIN_CLIP_MS, type Timeline } from "./timeline";

/**
 * Tempo detection and snapping cuts to the beat. Pure functions on raw audio
 * samples, so the same code analyses an upload in the browser and a library
 * import in the worker.
 */

export type BeatGrid = {
  /** Beats per minute. */
  bpm: number;
  /** Time of the first beat, in milliseconds from the start of the song. */
  offsetMs: number;
};

/** Sample rate the analysis expects. Plenty for rhythm, and cheap. */
export const BEAT_SAMPLE_RATE = 11_025;
const HOP = 256;
const MIN_BPM = 70;
const MAX_BPM = 180;

/**
 * How strongly the music "hits" at each moment: the rise in loudness from one
 * short window to the next. Drums and strummed chords make peaks here.
 */
function onsetEnvelope(samples: Float32Array): Float32Array {
  const frames = Math.floor(samples.length / HOP);
  const energy = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    const start = frame * HOP;
    for (let i = 0; i < HOP; i++) sum += samples[start + i] * samples[start + i];
    energy[frame] = Math.log1p(sum * 1000);
  }
  const onset = new Float32Array(frames);
  for (let frame = 1; frame < frames; frame++) onset[frame] = Math.max(0, energy[frame] - energy[frame - 1]);
  return onset;
}

/** Value of the envelope between two frames. */
function sample(envelope: Float32Array, position: number): number {
  const index = Math.floor(position);
  if (index < 0 || index + 1 >= envelope.length) return 0;
  const fraction = position - index;
  return envelope[index] * (1 - fraction) + envelope[index + 1] * fraction;
}

/** How well the onset pattern repeats after `lag` frames (lag may be fractional). */
function repetition(envelope: Float32Array, lag: number): number {
  let score = 0;
  for (let i = Math.ceil(lag); i < envelope.length; i++) score += envelope[i] * sample(envelope, i - lag);
  return score;
}

/** Mild preference for everyday tempos, to choose 120 over 60 or 240. */
function tempoPrior(bpm: number): number {
  return Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
}

/** Best alignment of a beat-spaced comb: its average onset strength and where it starts. */
function comb(envelope: Float32Array, period: number): { strength: number; phase: number } {
  let best = { strength: -1, phase: 0 };
  for (let phase = 0; phase < period; phase += 0.25) {
    let sum = 0;
    let count = 0;
    for (let position = phase; position < envelope.length - 1; position += period) {
      sum += sample(envelope, position);
      count++;
    }
    const strength = count > 0 ? sum / count : 0;
    if (strength > best.strength) best = { strength, phase };
  }
  return best;
}

/**
 * Finds the tempo and where the beats fall. Returns null for audio with no
 * steady pulse (speech, ambience) or that is too short to tell.
 */
export function detectBeats(samples: Float32Array, sampleRate: number = BEAT_SAMPLE_RATE): BeatGrid | null {
  const framesPerSecond = sampleRate / HOP;
  const raw = onsetEnvelope(samples);
  if (raw.length < framesPerSecond * 6) return null;

  // Blur slightly, so a beat that falls between two frames still lines up with itself.
  const onset = new Float32Array(raw.length);
  for (let i = 1; i < raw.length - 1; i++) onset[i] = 0.25 * raw[i - 1] + 0.5 * raw[i] + 0.25 * raw[i + 1];

  // 1. Rough tempo: the lag at which the pattern best repeats.
  const minLag = (60 / MAX_BPM) * framesPerSecond;
  const maxLag = (60 / MIN_BPM) * framesPerSecond;
  let bestLag = 0;
  let bestScore = 0;
  let total = 0;
  let count = 0;
  for (let lag = Math.floor(minLag); lag <= Math.ceil(maxLag); lag++) {
    const score = repetition(onset, lag) * tempoPrior((60 * framesPerSecond) / lag);
    total += score;
    count++;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestScore <= 0) return null;
  // A flat score across all lags means there is no pulse to follow.
  if (bestScore < (total / count) * 1.15) return null;

  // 2. A pattern that repeats every beat also repeats every two beats. If
  //    half the lag fits nearly as well, the faster tempo is the real one.
  let lag = bestLag;
  const half = lag / 2;
  if (half >= minLag) {
    const fast = repetition(onset, half) * tempoPrior((60 * framesPerSecond) / half);
    if (fast > bestScore * 0.75) lag = half;
  }

  // 3. Exact tempo: over a whole song a small error in the period drifts off
  //    the beat, so search finely for the period whose comb fits best.
  let period = lag;
  let fit = comb(onset, lag);
  for (let candidate = lag - 1; candidate <= lag + 1; candidate += 0.01) {
    const next = comb(onset, candidate);
    if (next.strength > fit.strength) {
      fit = next;
      period = candidate;
    }
  }

  const bpm = Math.round(((60 * framesPerSecond) / period) * 10) / 10;
  if (bpm < 40 || bpm > 240) return null;
  return { bpm, offsetMs: Math.max(0, Math.round((fit.phase / framesPerSecond) * 1000)) };
}

export function beatPeriodMs(grid: BeatGrid): number {
  return 60_000 / grid.bpm;
}

/** The beat nearest to \`ms\` on the reel, given where in the song the reel starts. */
export function nearestBeatMs(ms: number, grid: BeatGrid, songStartMs = 0): number {
  const period = beatPeriodMs(grid);
  const first = grid.offsetMs - songStartMs;
  return Math.round(first + Math.round((ms - first) / period) * period);
}

/**
 * Moves every cut onto a beat by lengthening or shortening the clip before
 * it. A photo can be any length; a video is never stretched past the end of
 * its source, and no clip gets shorter than one beat. Returns the timeline
 * unchanged if it has no music with a known tempo.
 */
export function snapCutsToBeats(timeline: Timeline, sourceDurationsMs: Record<string, number | null | undefined> = {}): Timeline {
  const music = timeline.music;
  if (!music?.bpm) return timeline;
  const grid: BeatGrid = { bpm: music.bpm, offsetMs: music.beatOffsetMs ?? 0 };
  const period = beatPeriodMs(grid);
  const shortest = Math.max(MIN_CLIP_MS, period);

  let start = 0;
  const clips = timeline.clips.map((clip) => {
    const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
    const sourceLength = clip.kind === "VIDEO" ? sourceDurationsMs[clip.assetId] : null;
    const longest = sourceLength ? (sourceLength - clip.sourceStartMs) / speed : Infinity;

    let end = nearestBeatMs(start + clipDurationMs(clip), grid, music.sourceStartMs);
    while (end - start < shortest) end += period;
    while (end - start > longest && end - period - start >= shortest) end -= period;
    if (end - start > longest) {
      // The source is shorter than one beat from here: leave this clip as it is.
      start += clipDurationMs(clip);
      return clip;
    }
    const duration = Math.round(end - start);
    start += duration;
    return { ...clip, sourceEndMs: clip.sourceStartMs + Math.round(duration * speed) };
  });

  const total = start;
  const texts = timeline.texts
    .filter((text) => text.startMs < total)
    .map((text) => (text.endMs > total ? { ...text, endMs: total } : text));
  return { ...timeline, clips, texts };
}
