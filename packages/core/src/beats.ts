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
 * Tempo ratios a repeating pattern also fits (the harmonics of the beat): a
 * track with dotted-eighth hats repeats every three sixteenths as strongly
 * as every beat, so the autocorrelation peak may sit at 4/3 of the tempo.
 * Each is tried against the whole onset curve before the tempo is settled.
 */
const TEMPO_RATIOS = [1 / 2, 2 / 3, 3 / 4, 1, 4 / 3, 3 / 2, 2] as const;
/** Where the tempo preference is centred and how wide it is, in octaves. */
const TEMPO_PREFERENCE = { centreBpm: 110, widthOctaves: 0.6 } as const;

/**
 * How strongly the music "hits" at each moment: the rise in loudness from one
 * short window to the next. Drums and strummed chords make peaks here. One
 * value per `HOP` samples (43 a second at `BEAT_SAMPLE_RATE`).
 */
export function beatOnsets(samples: Float32Array): Float32Array {
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

/** Mild preference for everyday tempos while looking for the rough period, to choose 120 over 60 or 240. */
function tempoPrior(bpm: number): number {
  return Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
}

/**
 * The preference between harmonically related tempos that explain the onsets
 * about as well: 80–140 bpm over their halves, doubles, and 3:4 or 2:3
 * relatives. A log-normal bump centred at 110 bpm; 160 bpm needs to explain
 * the onsets about half again as well as 120 to be chosen over it.
 */
function tempoPreference(bpm: number): number {
  return Math.exp(-0.5 * (Math.log2(bpm / TEMPO_PREFERENCE.centreBpm) / TEMPO_PREFERENCE.widthOctaves) ** 2);
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

type CombFit = { period: number; phase: number; strength: number };

/**
 * The exact period near `lag`: over a whole song a small error in the period
 * drifts off the beat, so the comb is fitted finely (to a fiftieth of a
 * frame) within one frame either side.
 */
function finePeriod(envelope: Float32Array, lag: number): CombFit {
  let best: CombFit = { period: lag, ...comb(envelope, lag) };
  for (let candidate = lag - 1; candidate <= lag + 1; candidate += 0.1) {
    const next = comb(envelope, candidate);
    if (next.strength > best.strength) best = { period: candidate, ...next };
  }
  const coarse = best.period;
  for (let candidate = coarse - 0.1; candidate <= coarse + 0.1; candidate += 0.02) {
    const next = comb(envelope, candidate);
    if (next.strength > best.strength) best = { period: candidate, ...next };
  }
  return best;
}

/** At most this many autocorrelation peaks seed the candidate tempos. */
const MAX_PEAKS = 4;
/** A peak below this share of the best one is noise, not a rival tempo. */
const PEAK_SHARE = 0.5;

/**
 * The lags worth fitting as a beat comb: the strongest local maxima of the
 * (prior-weighted) autocorrelation and each one's harmonics (TEMPO_RATIOS),
 * within the tempo range, without near-duplicates. The true tempo is nearly
 * always among them: either a peak itself or a 2:3, 3:4, 4:3, 3:2 or 2:1
 * relative of one.
 */
function candidateLags(scores: readonly number[], firstLag: number, minLag: number, maxLag: number): number[] {
  const best = Math.max(...scores);
  const peaks: { lag: number; score: number }[] = [];
  for (let i = 0; i < scores.length; i++) {
    const left = i === 0 ? -Infinity : scores[i - 1];
    const right = i === scores.length - 1 ? -Infinity : scores[i + 1];
    if (scores[i] >= left && scores[i] >= right && scores[i] >= best * PEAK_SHARE) peaks.push({ lag: firstLag + i, score: scores[i] });
  }
  peaks.sort((a, b) => b.score - a.score);
  const lags: number[] = [];
  for (const peak of peaks.slice(0, MAX_PEAKS)) {
    for (const ratio of TEMPO_RATIOS) {
      const lag = peak.lag / ratio;
      if (lag < minLag || lag > maxLag) continue;
      if (lags.some((known) => Math.abs(known - lag) < 0.5)) continue;
      lags.push(lag);
    }
  }
  return lags;
}

/**
 * Finds the tempo and where the beats fall from an onset curve of
 * `framesPerSecond` values a second (`beatOnsets`). Returns null for audio
 * with no steady pulse (speech, ambience) or that is too short to tell.
 *
 * 1. The rough periods are the lags at which the onsets best repeat: the
 *    strongest peaks of the autocorrelation.
 * 2. Each peak and its harmonics (half, double, and the 2:3, 3:4, 4:3, 3:2
 *    relatives: TEMPO_RATIOS) are fitted as a beat comb over the whole
 *    curve; the comb whose beats land on the most onset energy wins, with a
 *    preference for everyday tempos when they are close. The 4:3 lock of a
 *    track with dotted-eighth hats loses here: its comb hits the hats but
 *    misses every other kick.
 * 3. The beats start where the winning comb starts, so the phase and the
 *    bars counted from it (analyseSong) belong to the chosen tempo.
 */
export function detectBeatsFromOnsets(raw: Float32Array, framesPerSecond: number): BeatGrid | null {
  if (raw.length < framesPerSecond * 6) return null;

  // Blur slightly, so a beat that falls between two frames still lines up with itself.
  const onset = new Float32Array(raw.length);
  for (let i = 1; i < raw.length - 1; i++) onset[i] = 0.25 * raw[i - 1] + 0.5 * raw[i] + 0.25 * raw[i + 1];

  // 1. Rough tempo: the lags at which the pattern best repeats.
  const minLag = (60 / MAX_BPM) * framesPerSecond;
  const maxLag = (60 / MIN_BPM) * framesPerSecond;
  const firstLag = Math.floor(minLag);
  const scores: number[] = [];
  let bestScore = 0;
  for (let lag = firstLag; lag <= Math.ceil(maxLag); lag++) {
    const score = repetition(onset, lag) * tempoPrior((60 * framesPerSecond) / lag);
    scores.push(score);
    if (score > bestScore) bestScore = score;
  }
  if (bestScore <= 0) return null;
  // A flat score across all lags means there is no pulse to follow.
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  if (bestScore < mean * 1.15) return null;

  // 2. The peaks and their harmonics, each fitted as a comb over the whole curve: the one whose beats explain the most onset energy wins.
  let best: (CombFit & { score: number }) | null = null;
  for (const lag of candidateLags(scores, firstLag, minLag, maxLag)) {
    const fit = finePeriod(onset, lag);
    const score = fit.strength * tempoPreference((60 * framesPerSecond) / fit.period);
    if (!best || score > best.score) best = { ...fit, score };
  }
  if (!best || best.strength <= 0) return null;

  // 3. The grid: tempo from the winning period, first beat where its comb starts.
  const bpm = Math.round(((60 * framesPerSecond) / best.period) * 10) / 10;
  if (bpm < 40 || bpm > 240) return null;
  return { bpm, offsetMs: Math.max(0, Math.round((best.phase / framesPerSecond) * 1000)) };
}

/**
 * Finds the tempo and where the beats fall. Returns null for audio with no
 * steady pulse (speech, ambience) or that is too short to tell.
 */
export function detectBeats(samples: Float32Array, sampleRate: number = BEAT_SAMPLE_RATE): BeatGrid | null {
  return detectBeatsFromOnsets(beatOnsets(samples), sampleRate / HOP);
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
