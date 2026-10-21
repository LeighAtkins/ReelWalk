import { z } from "zod";
import { BEAT_SAMPLE_RATE, beatPeriodMs, type BeatGrid } from "./beats";
import { MAX_DOWNBEATS, MAX_SECTIONS, songSectionSchema, type SectionKind, type SongSection } from "./timeline";

/**
 * A song's structure (ADR 0059): where its bars start (downbeats) and its
 * sections (a quiet intro, a build, the drop, an outro), found from the same
 * raw mono samples the tempo detector reads. Pure arithmetic, so the browser
 * (uploads, an Instagram sound's private preview copy) and the worker
 * (library imports, decoded by ffmpeg) share it, and tests feed it a
 * generated click track.
 *
 * Times are song time in milliseconds, like `Music.beatOffsetMs`.
 */

export const BEATS_PER_BAR = 4;
const ms = z.number().int().min(0);

export const songMapSchema = z.object({
  /** Song time (ms) of the first beat of every bar, ascending. */
  downbeats: z.array(ms).max(MAX_DOWNBEATS),
  /** Contiguous from 0 to the song's (analysed) end. Empty when the song has no clear structure. */
  sections: z.array(songSectionSchema).max(MAX_SECTIONS),
});
export type SongMap = z.infer<typeof songMapSchema>;

/** A stored song map as the fields a reel's music carries (none when there is no valid map). */
export function songMapFields(value: unknown): Partial<SongMap> {
  const map = parseSongMap(value);
  return map ? { downbeats: map.downbeats, sections: map.sections } : {};
}

/** Reads a stored song map (a database column, a timeline), or null when there is none or it is not one. */
export function parseSongMap(value: unknown): SongMap | null {
  const parsed = songMapSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One-pole low-pass, so the kick drum (which usually marks the bar) stands out from hats and clicks. */
function lowPass(samples: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const out = new Float32Array(samples.length);
  let y = 0;
  for (let i = 0; i < samples.length; i++) {
    y += a * (samples[i] - y);
    out[i] = y;
  }
  return out;
}

/** Mean square of `samples` over [from, to) samples, clamped to the buffer. */
function meanSquare(samples: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(samples.length, Math.floor(to));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return sum / (b - a);
}

/** The positive rises in short-window energy: how much is struck, per window. */
function onsetStrength(samples: Float32Array, hop: number): Float32Array {
  const frames = Math.floor(samples.length / hop);
  const out = new Float32Array(frames);
  let last = 0;
  for (let frame = 0; frame < frames; frame++) {
    const energy = Math.log1p(meanSquare(samples, frame * hop, (frame + 1) * hop) * 1000);
    out[frame] = frame === 0 ? 0 : Math.max(0, energy - last);
    last = energy;
  }
  return out;
}

function normalise(values: number[]): number[] {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return values.map((value) => (high - low > 1e-9 ? (value - low) / (high - low) : 0));
}

function median3(values: number[]): number[] {
  return values.map((value, i) => {
    if (i === 0 || i === values.length - 1) return value;
    const three = [values[i - 1], value, values[i + 1]].sort((a, b) => a - b);
    return three[1];
  });
}

/**
 * Finds the downbeats and sections of a song whose tempo is `grid`.
 *
 * Downbeats: the beats are already known; which of every four starts the bar
 * is the phase whose beats carry the most low-frequency attack (the kick),
 * helped by where the bar-to-bar loudness changes (sections start on a bar).
 *
 * Sections: every bar gets a level from its loudness (dB-like) and how much
 * is struck in it (hats in a build add attacks without much loudness),
 * normalised over the song and smoothed over three bars. High bars are the
 * drop; quiet bars before the first drop are the intro, the rest before a
 * drop the build; after the last drop comes the outro. A song whose bars all
 * sit within a narrow band (a steady loop) has no sections.
 */
export function analyseSong(samples: Float32Array, grid: BeatGrid, sampleRate: number = BEAT_SAMPLE_RATE): SongMap {
  const durationMs = Math.floor((samples.length / sampleRate) * 1000);
  const period = beatPeriodMs(grid);
  const beats: number[] = [];
  for (let t = grid.offsetMs; t < durationMs; t += period) beats.push(t);
  if (beats.length < BEATS_PER_BAR * 2) return { downbeats: [], sections: [] };

  const toSample = (t: number) => (t * sampleRate) / 1000;
  const low = lowPass(samples, sampleRate, 180);
  // Low-frequency attack at each beat: energy just after it against just before it.
  const attack = beats.map((t) => {
    const after = meanSquare(low, toSample(t - 10), toSample(t + 70));
    const before = meanSquare(low, toSample(t - 90), toSample(t - 10));
    return Math.max(0, Math.sqrt(after) - Math.sqrt(before));
  });
  const beatEnergy = beats.map((t) => Math.log(meanSquare(samples, toSample(t), toSample(t + period)) + 1e-8));
  let phase = 0;
  let best = -Infinity;
  for (let p = 0; p < BEATS_PER_BAR; p++) {
    let accent = 0;
    let change = 0;
    let count = 0;
    for (let k = p; k < beats.length; k += BEATS_PER_BAR) {
      accent += attack[k];
      // Loudness change across this candidate bar line (a bar's mean against the previous bar's).
      if (k >= BEATS_PER_BAR && k + BEATS_PER_BAR <= beats.length) {
        const mean = (from: number) => beatEnergy.slice(from, from + BEATS_PER_BAR).reduce((sum, value) => sum + value, 0) / BEATS_PER_BAR;
        change += Math.abs(mean(k) - mean(k - BEATS_PER_BAR));
      }
      count++;
    }
    const meanAttack = accent / count;
    const score = meanAttack / (Math.max(...attack) + 1e-9) + 0.25 * (change / count);
    if (score > best + 1e-9) {
      best = score;
      phase = p;
    }
  }
  const downbeats = beats.filter((_, k) => k % BEATS_PER_BAR === phase).map((t) => Math.round(t)).slice(0, MAX_DOWNBEATS);
  return { downbeats, sections: findSections(samples, sampleRate, downbeats, period, durationMs) };
}

function findSections(samples: Float32Array, sampleRate: number, downbeats: number[], period: number, durationMs: number): SongSection[] {
  const barMs = period * BEATS_PER_BAR;
  // Whole bars only: the pickup before the first downbeat joins the first section, a part bar at the end the last.
  const bars = downbeats.filter((t) => t + barMs <= durationMs + 1);
  if (bars.length < 4) return [];
  const toSample = (t: number) => (t * sampleRate) / 1000;
  const hop = 128;
  const onset = onsetStrength(samples, hop);
  const framesPerMs = sampleRate / hop / 1000;
  const loudness = bars.map((t) => Math.log10(meanSquare(samples, toSample(t), toSample(t + barMs)) + 1e-8) * 10);
  const struck = bars.map((t) => {
    let sum = 0;
    const a = Math.floor(t * framesPerMs);
    const b = Math.min(onset.length, Math.floor((t + barMs) * framesPerMs));
    for (let i = a; i < b; i++) sum += onset[i];
    return sum;
  });
  // A steady loop: less than 3 dB between its quietest and loudest bars and much the same attacks throughout.
  const loudSpread = Math.max(...loudness) - Math.min(...loudness);
  const struckMax = Math.max(...struck);
  const struckSpread = struckMax > 0 ? (struckMax - Math.min(...struck)) / struckMax : 0;
  if (loudSpread < 3 && struckSpread < 0.35) return [];

  const level = median3(normalise(loudness).map((value, i) => 0.6 * value + 0.4 * normalise(struck)[i]));
  const kinds: SectionKind[] = new Array(bars.length);
  const high = level.map((value) => value >= 0.66);
  const firstDrop = high.indexOf(true);
  const lastDrop = high.lastIndexOf(true);
  for (let i = 0; i < bars.length; i++) {
    if (high[i]) kinds[i] = "drop";
    else if (i > lastDrop) kinds[i] = "outro";
    else kinds[i] = "build";
  }
  // The intro: the quiet bars at the start, before anything builds.
  for (let i = 0; i < firstDrop && level[i] < 0.33; i++) kinds[i] = "intro";
  // A one-bar gap inside a drop (a fill) stays part of the drop.
  for (let i = 1; i < bars.length - 1; i++) if (kinds[i] === "build" && kinds[i - 1] === "drop" && kinds[i + 1] === "drop") kinds[i] = "drop";

  const sections: SongSection[] = [];
  for (let i = 0; i < bars.length; i++) {
    const startMs = i === 0 ? 0 : Math.round(bars[i]);
    const last = sections[sections.length - 1];
    if (last && last.kind === kinds[i]) continue;
    if (last) last.endMs = startMs;
    sections.push({ kind: kinds[i], startMs, endMs: durationMs });
  }
  return sections.slice(0, MAX_SECTIONS);
}

/** The section playing at song time `songMs`, or null when the song has no sections or it is past them. */
export function sectionAt(sections: readonly SongSection[], songMs: number): SongSection | null {
  return sections.find((section) => songMs >= section.startMs && songMs < section.endMs) ?? null;
}
