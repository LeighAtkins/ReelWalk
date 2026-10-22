import { z } from "zod";
import { BEAT_SAMPLE_RATE, beatPeriodMs, detectBeats, type BeatGrid } from "./beats";
import { analyseSong, songMapSchema, type SongMap } from "./song";
import { MAX_DOWNBEATS, MAX_SECTIONS, songSectionSchema, type Music, type Timeline } from "./timeline";

/**
 * Everything the editor and an agent want to know about a track's rhythm
 * and shape (ADR 0066), from the same raw mono samples the tempo detector
 * reads: the beat grid as a list, the bars, the sections, an energy curve
 * and the first drop. Pure, so the worker (ffmpeg decode) and the browser
 * (Web Audio decode) make byte-identical answers, cached per audio id.
 *
 * Times are song time in milliseconds, like `Music.beatOffsetMs`.
 */

/**
 * Bumped when the detector improves, so every cached analysis is made again:
 * v2 is the tempo estimator that checks the harmonics of the autocorrelation
 * peak (a 4:3 lock read 120 bpm as 160 before it).
 */
export const AUDIO_ANALYSIS_VERSION = 2;
/** The energy curve's step. */
export const ENERGY_STEP_MS = 100;
/** At most this many beats are listed: about six minutes at 180 bpm. */
export const MAX_BEATS = 1100;
const MAX_ENERGY_STEPS = 6000;

const ms = z.number().int().min(0);

export const audioAnalysisSchema = z.object({
  version: z.literal(AUDIO_ANALYSIS_VERSION),
  /** How much of the track was analysed (the first 90 s at most). */
  durationMs: ms,
  bpm: z.number().min(40).max(240).nullable(),
  beatOffsetMs: ms.nullable(),
  /** Song time of every beat, ascending. Empty when no pulse was found. */
  beats: z.array(ms).max(MAX_BEATS),
  downbeats: z.array(ms).max(MAX_DOWNBEATS),
  sections: z.array(songSectionSchema).max(MAX_SECTIONS),
  /** Loudness per ENERGY_STEP_MS, 0 (the quietest step) to 1 (the loudest), smoothed over three steps. */
  energy: z.object({ stepMs: z.literal(ENERGY_STEP_MS), values: z.array(z.number().min(0).max(1)).max(MAX_ENERGY_STEPS) }),
  /** The first drop: the largest sustained rise in energy, on a bar line when the bars are known. Null when the track never lifts. */
  drop: z.object({ atMs: ms, riseDb: z.number() }).nullable(),
});
export type AudioAnalysis = z.infer<typeof audioAnalysisSchema>;

/** Reads a stored analysis; null when it is missing, malformed, or from another version. */
export function parseAudioAnalysis(value: unknown): AudioAnalysis | null {
  const parsed = audioAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** RMS per step as dB (−100 for silence). */
function stepLoudnessDb(samples: Float32Array, sampleRate: number, stepMs: number): number[] {
  const hop = Math.round((sampleRate * stepMs) / 1000);
  const steps = Math.floor(samples.length / hop);
  const out: number[] = [];
  for (let step = 0; step < steps; step++) {
    let sum = 0;
    const start = step * hop;
    for (let i = 0; i < hop; i++) sum += samples[start + i] * samples[start + i];
    out.push(10 * Math.log10(sum / hop + 1e-10));
  }
  return out;
}

/** The energy curve: dB per step, normalised over the track and smoothed over three steps. */
export function energyCurve(loudnessDb: readonly number[]): number[] {
  if (loudnessDb.length === 0) return [];
  const floor = Math.max(-80, Math.min(...loudnessDb));
  const ceiling = Math.max(...loudnessDb);
  const span = ceiling - floor;
  const unit = loudnessDb.map((db) => (span > 1e-6 ? Math.min(1, Math.max(0, (db - floor) / span)) : 0));
  return unit.map((value, i) => {
    const a = unit[Math.max(0, i - 1)];
    const b = unit[Math.min(unit.length - 1, i + 1)];
    return Math.round(((a + value + b) / 3) * 1000) / 1000;
  });
}

/** Window the drop detector compares either side of a candidate, in ms. */
export const DROP_WINDOW_MS = 2000;
/** A rise smaller than this is not a drop. */
export const DROP_MIN_RISE_DB = 3;

/**
 * The first drop: among the candidate moments (the downbeats when known,
 * else the beats, else every step), the one with the largest sustained
 * rise, the mean loudness of the two seconds after it against the two
 * seconds before. A bar whose rise is within 1 dB of the best and comes
 * earlier wins, so a long build that keeps rising lands on its first big
 * step, not its last. Null when nothing rises by DROP_MIN_RISE_DB.
 */
export function findDrop(loudnessDb: readonly number[], stepMs: number, candidatesMs: readonly number[]): { atMs: number; riseDb: number } | null {
  const steps = loudnessDb.length;
  if (steps === 0) return null;
  const window = Math.max(1, Math.round(DROP_WINDOW_MS / stepMs));
  const candidates = candidatesMs.length > 0 ? candidatesMs : Array.from({ length: steps }, (_, i) => i * stepMs);
  const mean = (from: number, to: number) => {
    const a = Math.max(0, from);
    const b = Math.min(steps, to);
    if (b <= a) return null;
    let sum = 0;
    for (let i = a; i < b; i++) sum += loudnessDb[i];
    return sum / (b - a);
  };
  let best: { atMs: number; riseDb: number } | null = null;
  for (const atMs of candidates) {
    const at = Math.round(atMs / stepMs);
    if (at < 1 || at >= steps) continue;
    const before = mean(at - window, at);
    const after = mean(at, at + window);
    if (before === null || after === null) continue;
    const rise = after - before;
    if (rise < DROP_MIN_RISE_DB) continue;
    if (!best || rise > best.riseDb + 1) best = { atMs: Math.round(atMs), riseDb: Math.round(rise * 10) / 10 };
  }
  return best;
}

/**
 * The full analysis of a decoded track (mono samples at `sampleRate`,
 * BEAT_SAMPLE_RATE unless said otherwise). The beat grid comes from
 * `detectBeats`, the bars and sections from `analyseSong` (ADR 0059).
 */
export function analyseAudio(samples: Float32Array, sampleRate: number = BEAT_SAMPLE_RATE): AudioAnalysis {
  const durationMs = Math.floor((samples.length / sampleRate) * 1000);
  const grid = detectBeats(samples, sampleRate);
  const map: SongMap = grid ? analyseSong(samples, grid, sampleRate) : { downbeats: [], sections: [] };
  const beats = grid ? beatsOf(grid, durationMs) : [];
  const loudnessDb = stepLoudnessDb(samples, sampleRate, ENERGY_STEP_MS);
  const candidates = map.downbeats.length > 0 ? map.downbeats : beats;
  return {
    version: AUDIO_ANALYSIS_VERSION,
    durationMs,
    bpm: grid?.bpm ?? null,
    beatOffsetMs: grid?.offsetMs ?? null,
    beats,
    downbeats: map.downbeats,
    sections: map.sections,
    energy: { stepMs: ENERGY_STEP_MS, values: energyCurve(loudnessDb).slice(0, MAX_ENERGY_STEPS) },
    drop: findDrop(loudnessDb, ENERGY_STEP_MS, candidates),
  };
}

/** Every beat of a grid up to `durationMs`, rounded to whole ms. */
export function beatsOf(grid: BeatGrid, durationMs: number): number[] {
  const period = beatPeriodMs(grid);
  const out: number[] = [];
  for (let t = grid.offsetMs; t < durationMs && out.length < MAX_BEATS; t += period) out.push(Math.round(t));
  return out;
}

/** The beat grid a reel's music stores: tempo and first beat, with the bars and sections when they are known. */
export type MusicGridFields = Pick<Music, "bpm" | "beatOffsetMs"> & Partial<Pick<Music, "downbeats" | "sections">>;

/** The music fields a reel stores from an analysis (`setMusic`), so pacing and "On the beat" use the measured grid. */
export function musicFieldsFromAnalysis(analysis: AudioAnalysis): MusicGridFields {
  return {
    bpm: analysis.bpm,
    beatOffsetMs: analysis.beatOffsetMs,
    ...(analysis.downbeats.length > 0 ? { downbeats: analysis.downbeats, sections: analysis.sections } : {}),
  };
}

const sameList = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The reel's music on the grid the analysis measured. The analysis is the
 * one source of the beat grid: the music record keeps a copy for the pacing
 * engine, the critic and "Snap to the beat", and that copy must follow a
 * corrected analysis (an agent's PUT, a better detector). Nothing else about
 * the music changes, and no cut moves. The same object comes back when the
 * grid already matches, or the analysis found no pulse (the reel keeps what
 * it had).
 */
export function musicWithGrid(music: Music, grid: MusicGridFields): Music {
  if (grid.bpm === null) return music;
  const bars = grid.downbeats !== undefined && grid.downbeats.length > 0;
  const same =
    music.bpm === grid.bpm &&
    (music.beatOffsetMs ?? 0) === (grid.beatOffsetMs ?? 0) &&
    (!bars || (sameList(music.downbeats, grid.downbeats) && sameList(music.sections, grid.sections)));
  if (same) return music;
  return { ...music, bpm: grid.bpm, beatOffsetMs: grid.beatOffsetMs, ...(bars ? { downbeats: grid.downbeats, sections: grid.sections ?? [] } : {}) };
}

/** `musicWithGrid` on a timeline: the same timeline when its music already sits on the grid or it has none. */
export function timelineWithGrid(timeline: Timeline, grid: MusicGridFields): Timeline {
  if (!timeline.music) return timeline;
  const music = musicWithGrid(timeline.music, grid);
  return music === timeline.music ? timeline : { ...timeline, music };
}

/** An analysis's song map as the stored column expects it, or null without bars. */
export function songMapFromAnalysis(analysis: AudioAnalysis): SongMap | null {
  const map = songMapSchema.safeParse({ downbeats: analysis.downbeats, sections: analysis.sections });
  return map.success && map.data.downbeats.length > 0 ? map.data : null;
}

/**
 * Song times moved into reel time: the reel starts `sourceStartMs` into the
 * song (always 0 for an Instagram sound) and runs `reelMs`. Beats past the
 * analysed part of the song are extrapolated from the grid, as pacing does.
 */
export function reelBeats(analysis: Pick<AudioAnalysis, "bpm" | "beatOffsetMs" | "beats">, sourceStartMs: number, reelMs: number): number[] {
  if (!analysis.bpm || analysis.beatOffsetMs === null) return [];
  const period = beatPeriodMs({ bpm: analysis.bpm, offsetMs: analysis.beatOffsetMs });
  const first = analysis.beatOffsetMs - sourceStartMs;
  const out: number[] = [];
  const k0 = Math.ceil((0 - first) / period - 1e-9);
  for (let k = Math.max(0, k0); ; k++) {
    const at = first + k * period;
    if (at > reelMs) break;
    out.push(Math.round(at));
    if (out.length >= MAX_BEATS) break;
  }
  return out;
}

/** Where a track's analysis is cached in storage: beside the audio object it was made from. */
export const audioAnalysisKeyFor = (objectKey: string): string => `${objectKey}.analysis.v${AUDIO_ANALYSIS_VERSION}.json`;
