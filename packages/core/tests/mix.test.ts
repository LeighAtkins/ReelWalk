import { describe, expect, it } from "vitest";
import { duckEnvelope, EXPORT_LOUDNESS, gainToTarget, integratedLoudness, kWeight, loudnessBlocks, loudnormFilter, measureLoudness, parseLoudnorm, recommendSoundVolume, resampleLoudness, truePeakDb, withinTarget } from "../src";

const RATE = 48_000;

function sine(hz: number, dbfs: number, seconds: number, rate = RATE): Float32Array {
  const amplitude = 10 ** (dbfs / 20);
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

describe("loudness (BS.1770)", () => {
  it("reads a −20 dBFS 1 kHz sine in both channels as −20 LUFS", () => {
    const channel = sine(1000, -20, 5);
    const { integrated, blocks } = measureLoudness([channel, channel], RATE);
    expect(integrated).toBeCloseTo(-20, 0);
    expect(Math.abs(integrated + 20)).toBeLessThan(0.35);
    // Momentary blocks every 100 ms: the first ends at 400 ms.
    expect(blocks.stepMs).toBe(100);
    expect(blocks.lufs.length).toBe(47);
    expect(blocks.lufs[10]).toBeCloseTo(-20, 0);
  });

  it("reads the same sine in one channel 3 dB lower, and a 100 Hz tone lower still (the K curve)", () => {
    const channel = sine(1000, -20, 3);
    expect(measureLoudness([channel], RATE).integrated).toBeCloseTo(-23, 0);
    const low = sine(100, -20, 3);
    expect(measureLoudness([low, low], RATE).integrated).toBeLessThan(-21);
    expect(measureLoudness([low, low], RATE).integrated).toBeGreaterThan(-24);
    // And a 10 kHz tone higher: the shelf adds about 4 dB.
    const high = sine(10_000, -20, 3);
    expect(measureLoudness([high, high], RATE).integrated).toBeGreaterThan(-17.5);
  });

  it("works at other sample rates", () => {
    const channel = sine(1000, -20, 3, 44_100);
    expect(Math.abs(measureLoudness([channel, channel], 44_100).integrated + 20)).toBeLessThan(0.35);
  });

  it("gates silence out of the integrated value", () => {
    const loud = sine(1000, -20, 2);
    const silent = new Float32Array(RATE * 4);
    const mixed = new Float32Array(loud.length + silent.length);
    mixed.set(loud);
    mixed.set(silent, loud.length);
    const { integrated } = measureLoudness([mixed, mixed], RATE);
    expect(Math.abs(integrated + 20)).toBeLessThan(0.6);
    expect(integratedLoudness([])).toBe(-Infinity);
    expect(integratedLoudness(Array(10).fill(-90))).toBe(-Infinity);
    // A short dip 10 LU under is still counted (the relative gate is 10 LU under the mean).
    expect(integratedLoudness([-20, -20, -20, -29])).toBeLessThan(-20);
    expect(integratedLoudness([-20, -20, -20, -40])).toBeCloseTo(-20, 1);
  });

  it("keeps the raw blocks when asked and re-samples them for a strip", () => {
    const weighted = kWeight(sine(1000, -20, 1), RATE);
    const blocks = loudnessBlocks([weighted, weighted], RATE, { stepMs: 50 });
    expect(blocks.lufs.length).toBe(13);
    expect(resampleLoudness({ stepMs: 100, blockMs: 400, lufs: [-30, -20, -25, -22, -40] }, 250)).toEqual([-20, -22]);
  });
});

describe("true peak and the gain to target", () => {
  it("finds a peak between samples", () => {
    // A 12 kHz sine at 48 kHz has samples at 0, 1, 0, −1: the sample peak is 0 dB, and so is the true peak.
    const full = sine(12_000, 0, 0.1);
    expect(truePeakDb([full])).toBeCloseTo(0, 0);
    // Phase-shifted so no sample hits the peak: the sample peak is −3 dB but the true peak is still about 0.
    const shifted = new Float32Array(full.length);
    for (let i = 0; i < shifted.length; i++) shifted[i] = Math.sin((2 * Math.PI * 12_000 * i) / RATE + Math.PI / 4);
    expect(20 * Math.log10(Math.max(...shifted.map(Math.abs)))).toBeLessThan(-2.9);
    expect(truePeakDb([shifted])).toBeGreaterThan(-0.5);
    expect(truePeakDb([new Float32Array(100)])).toBeLessThan(-200);
  });

  it("takes the smaller of the move to level and the move to the ceiling", () => {
    expect(gainToTarget({ lufs: -22, truePeakDb: -8 })).toBe(6);
    expect(gainToTarget({ lufs: -22, truePeakDb: -3 })).toBe(2);
    expect(gainToTarget({ lufs: -12, truePeakDb: -0.5 })).toBe(-4);
    expect(gainToTarget({ lufs: -Infinity, truePeakDb: -100 })).toBe(0);
    expect(EXPORT_LOUDNESS).toEqual({ lufs: -16, truePeakDb: -1 });
  });
});

describe("ffmpeg loudnorm strings", () => {
  const output = 'frame=1\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-22.30",\n\t"input_tp" : "-4.10",\n\t"input_lra" : "6.20",\n\t"input_thresh" : "-32.50",\n\t"output_i" : "-16.00",\n\t"target_offset" : "0.10"\n}\n';
  it("parses the measurement and builds the second pass at −16 LUFS, −1 dBTP", () => {
    const measured = parseLoudnorm(output)!;
    expect(measured.input_i).toBe("-22.30");
    expect(loudnormFilter(measured)).toBe("loudnorm=I=-16:TP=-1:LRA=11:measured_I=-22.30:measured_TP=-4.10:measured_LRA=6.20:measured_thresh=-32.50:offset=0.10:linear=true");
    expect(withinTarget(measured)).toBe(false);
    expect(withinTarget({ ...measured, input_i: "-16.4", input_tp: "-1.2" })).toBe(true);
    expect(withinTarget({ ...measured, input_i: "-16.4", input_tp: "-0.2" })).toBe(false);
    expect(parseLoudnorm("nothing here")).toBeNull();
  });
});

describe("ducking envelope and the post's sound volume", () => {
  it("samples the duck under speech", () => {
    const envelope = duckEnvelope([{ startMs: 1000, endMs: 2000 }], 3000, 250);
    expect(envelope).toHaveLength(12);
    expect(envelope[0]).toBe(1);
    expect(envelope[5]).toBe(0.3);
    expect(envelope[11]).toBe(1);
    expect(duckEnvelope([{ startMs: 1000, endMs: 2000 }], 3000, 250, { duckTo: 0.2 })[5]).toBe(0.2);
  });

  it("recommends the sound alone for a silent export, under the voice with speech, over sound design otherwise", () => {
    expect(recommendSoundVolume({ integratedLufs: null, hasSpeech: false, hasOwnSound: false })).toMatchObject({ audioVolume: 100, videoVolume: 0 });
    expect(recommendSoundVolume({ integratedLufs: -70, hasSpeech: true, hasOwnSound: true })).toMatchObject({ audioVolume: 100, videoVolume: 0 });
    expect(recommendSoundVolume({ integratedLufs: -16, hasSpeech: true, hasOwnSound: true })).toMatchObject({ audioVolume: 40, videoVolume: 100 });
    expect(recommendSoundVolume({ integratedLufs: -16, hasSpeech: false, hasOwnSound: true })).toMatchObject({ audioVolume: 100, videoVolume: 60 });
  });
});
