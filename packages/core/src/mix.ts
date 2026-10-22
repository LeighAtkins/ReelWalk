import { duckGain, type SpeechWindow } from "./ducking";

/**
 * The mix's arithmetic (ADR 0066): loudness as ITU-R BS.1770-4 measures it
 * (K-weighting, 400 ms blocks, gated integration), a true-peak estimate,
 * the gain that brings an export to its target, the ducking envelope, and
 * the "sound volume" to recommend for the post. Pure, so the worker can
 * measure an export it rendered, the browser can draw the same numbers,
 * and tests can feed it sines.
 */

/** Export target: streaming level with headroom for the library track Instagram mixes on top. */
export const EXPORT_LOUDNESS = { lufs: -16, truePeakDb: -1 } as const;
/** Speech-free SFX and ambience under a presenter: how far they duck (deeper than the music's 0.3). */
export const SFX_DUCK = { duckTo: 0.2, rampMs: 200 } as const;

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function highShelf(sampleRate: number, f0: number, gainDb: number, q: number): Biquad {
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (gainDb / 20);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / q + K * K;
  return {
    b0: (Vh + (Vb * K) / q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / q + K * K) / a0,
  };
}

function highPass(sampleRate: number, f0: number, q: number): Biquad {
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + K / q + K * K;
  // The RLB curve as libebur128 builds it: numerator left at (1, −2, 1), only the poles normalised.
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / q + K * K) / a0 };
}

function filter(samples: Float32Array, { b0, b1, b2, a1, a2 }: Biquad): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** The K-weighting of BS.1770: a high shelf (+4 dB above ~1.7 kHz) then a high-pass (the RLB curve), designed for `sampleRate`. */
export function kWeight(samples: Float32Array, sampleRate: number): Float32Array {
  const shelf = highShelf(sampleRate, 1681.974450955533, 3.999843853973347, 0.7071752369554196);
  const rlb = highPass(sampleRate, 38.13547087602444, 0.5003270373238773);
  return filter(filter(samples, shelf), rlb);
}

/** Block loudness from the channels' mean squares: −0.691 + 10 log10(Σ zᵢ). Mono counts once; left and right once each. */
export const blockLoudness = (meanSquares: readonly number[]): number => -0.691 + 10 * Math.log10(meanSquares.reduce((sum, z) => sum + z, 0) + 1e-20);

export type LoudnessBlocks = { stepMs: number; blockMs: number; lufs: number[] };

/**
 * Momentary loudness every `stepMs` (400 ms blocks, hop `stepMs`) of
 * channels already K-weighted: the first block ends at 400 ms, each value
 * stands for the window ending there. Returns one value per hop up to the
 * end of the audio (the last window is cut short).
 */
export function loudnessBlocks(channels: readonly Float32Array[], sampleRate: number, { blockMs = 400, stepMs = 100 }: { blockMs?: number; stepMs?: number } = {}): LoudnessBlocks {
  const length = Math.min(...channels.map((channel) => channel.length));
  const block = Math.round((sampleRate * blockMs) / 1000);
  const hop = Math.round((sampleRate * stepMs) / 1000);
  const lufs: number[] = [];
  for (let end = Math.min(block, length); end <= length; end += hop) {
    const start = Math.max(0, end - block);
    const squares = channels.map((channel) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += channel[i] * channel[i];
      return sum / (end - start);
    });
    lufs.push(blockLoudness(squares));
    if (end === length) break;
  }
  return { stepMs, blockMs, lufs };
}

/** Integrated loudness of momentary blocks: gated at −70 LUFS absolute, then 10 LU under the gated mean. −Infinity for silence. */
export function integratedLoudness(blocks: readonly number[]): number {
  const power = (lufs: number) => 10 ** ((lufs + 0.691) / 10);
  const loud = blocks.filter((value) => value > -70);
  if (loud.length === 0) return -Infinity;
  const mean = (values: number[]) => -0.691 + 10 * Math.log10(values.reduce((sum, value) => sum + power(value), 0) / values.length);
  const relative = mean(loud) - 10;
  const gated = loud.filter((value) => value > relative);
  return gated.length === 0 ? -Infinity : mean(gated);
}

/**
 * Integrated loudness and momentary blocks of a decoded file (channels of
 * raw samples at `sampleRate`): K-weighted, 400 ms blocks every `stepMs`.
 */
export function measureLoudness(channels: readonly Float32Array[], sampleRate: number, stepMs = 100): { integrated: number; blocks: LoudnessBlocks } {
  const weighted = channels.map((channel) => kWeight(channel, sampleRate));
  const blocks = loudnessBlocks(weighted, sampleRate, { stepMs });
  return { integrated: integratedLoudness(blocks.lufs), blocks };
}

/** Four-times oversampling as BS.1770 does it: a windowed-sinc interpolator, 24 taps per phase, each phase summing to one. */
const HALF_TAPS = 12;
const OVERSAMPLE_PHASES: number[][] = [1, 2, 3].map((phase) => {
  const taps: number[] = [];
  for (let d = -HALF_TAPS; d < HALF_TAPS; d++) {
    const t = d + phase / 4;
    const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
    const window = 0.42 + 0.5 * Math.cos((Math.PI * t) / HALF_TAPS) + 0.08 * Math.cos((2 * Math.PI * t) / HALF_TAPS);
    taps.push(sinc * window);
  }
  const sum = taps.reduce((total, tap) => total + tap, 0);
  return taps.map((tap) => tap / sum);
});

/** True peak, dBTP: the largest sample after four-times oversampling (never under the sample peak). */
export function truePeakDb(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    const last = channel.length - 1;
    for (let i = 0; i <= last; i++) {
      peak = Math.max(peak, Math.abs(channel[i]));
      for (const taps of OVERSAMPLE_PHASES) {
        let value = 0;
        for (let k = 0; k < taps.length; k++) {
          const at = i + HALF_TAPS - k;
          value += taps[k] * channel[at < 0 ? 0 : at > last ? last : at];
        }
        peak = Math.max(peak, Math.abs(value));
      }
    }
  }
  return 20 * Math.log10(peak + 1e-12);
}

/** The gain (dB) that puts a mix on target without its true peak passing the ceiling: the smaller of the two moves. */
export function gainToTarget(measured: { lufs: number; truePeakDb: number }, target: { lufs: number; truePeakDb: number } = EXPORT_LOUDNESS): number {
  if (!Number.isFinite(measured.lufs)) return 0;
  const toLevel = target.lufs - measured.lufs;
  const toCeiling = target.truePeakDb - measured.truePeakDb;
  return Math.round(Math.min(toLevel, toCeiling) * 100) / 100;
}

/** The ducking envelope sampled every `stepMs` over `totalMs`: 1 clear of speech, `duckTo` under it. */
export function duckEnvelope(windows: SpeechWindow[], totalMs: number, stepMs: number, options: { duckTo?: number; rampMs?: number } = {}): number[] {
  const steps = Math.max(0, Math.ceil(totalMs / stepMs));
  return Array.from({ length: steps }, (_, i) => Math.round(duckGain(windows, i * stepMs, options) * 1000) / 1000);
}

/** Momentary blocks re-sampled to `stepMs` by taking the loudest block in each step (what a strip can draw). */
export function resampleLoudness(blocks: LoudnessBlocks, stepMs: number): number[] {
  const per = Math.max(1, Math.round(stepMs / blocks.stepMs));
  const out: number[] = [];
  for (let i = 0; i < blocks.lufs.length; i += per) out.push(Math.round(Math.max(...blocks.lufs.slice(i, i + per)) * 10) / 10);
  return out;
}

export type SoundVolumeAdvice = {
  /** Instagram's `audio_volume` for the library sound, 0 to 100. */
  audioVolume: number;
  /** Instagram's `video_volume` for the export's own track, 0 to 100. */
  videoVolume: number;
  /** One line saying why. */
  reason: string;
};

/**
 * What to set when posting with a library sound, from what the export's
 * own track holds. Instagram's library sounds sit near −14 LUFS and the
 * export at −16: with speech in it the sound comes down to 40 so the voice
 * stays about 6 LU on top; with only sound design the sound leads and the
 * design sits under it; a silent export takes the sound alone.
 */
export function recommendSoundVolume(input: { integratedLufs: number | null; hasSpeech: boolean; hasOwnSound: boolean }): SoundVolumeAdvice {
  // A measured export that is silent counts as having no sound; an unmeasured one (not rendered yet) goes by what the reel holds.
  const silent = input.integratedLufs !== null && (!Number.isFinite(input.integratedLufs) || input.integratedLufs < -45);
  if (!input.hasOwnSound || silent) return { audioVolume: 100, videoVolume: 0, reason: "The export has no sound of its own, so the Instagram sound plays alone." };
  if (input.hasSpeech) return { audioVolume: 40, videoVolume: 100, reason: "The export carries speech: the sound sits about 6 LU under the voice." };
  return { audioVolume: 100, videoVolume: 60, reason: "The export carries sound design only: it sits under the Instagram sound." };
}
