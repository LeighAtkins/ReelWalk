import { describe, expect, it } from "vitest";
import { analyseAudio, BEAT_SAMPLE_RATE, beatsOf, energyCurve, findDrop, musicFieldsFromAnalysis, parseAudioAnalysis, reelBeats } from "../src";

/** A click track with a kick on every bar, quiet for `quietSeconds`, then loud: a drop. */
function song(bpm: number, offsetMs: number, seconds: number, quietSeconds: number): Float32Array {
  const rate = BEAT_SAMPLE_RATE;
  const samples = new Float32Array(rate * seconds);
  const period = (60 / bpm) * rate;
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let beat = 0;
  for (let at = (offsetMs / 1000) * rate; at < samples.length; at += period, beat++) {
    const loud = at / rate >= quietSeconds ? 1 : 0.15;
    const kick = beat % 4 === 0;
    for (let i = 0; i < 1200 && at + i < samples.length; i++) {
      const fade = 1 - i / 1200;
      const low = kick ? Math.sin((2 * Math.PI * 55 * i) / rate) * 0.8 : 0;
      samples[Math.floor(at) + i] += (noise() * 0.5 * (i < 400 ? 1 - i / 400 : 0) + low) * fade * loud;
    }
  }
  // A sustained pad under the loud part, so the rise is sustained and not only the clicks.
  for (let i = Math.floor(quietSeconds * rate); i < samples.length; i++) samples[i] += Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3;
  return samples;
}

describe("analyseAudio", () => {
  const track = song(120, 250, 24, 8);
  const analysis = analyseAudio(track);

  it("finds the tempo, lists every beat, and the bars", () => {
    expect(analysis.bpm).toBeCloseTo(120, 0);
    expect(analysis.beatOffsetMs).not.toBeNull();
    expect(analysis.beats.length).toBeGreaterThanOrEqual(45);
    // Beats are 500 ms apart.
    for (let i = 1; i < analysis.beats.length; i++) expect(analysis.beats[i] - analysis.beats[i - 1]).toBeCloseTo(500, -1);
    expect(analysis.downbeats.length).toBeGreaterThan(8);
    expect(analysis.durationMs).toBe(24_000);
  });

  it("draws an energy curve that is low before the drop and high after it", () => {
    const { stepMs, values } = analysis.energy;
    expect(stepMs).toBe(100);
    // 24 s in 100 ms steps (the hop is a whole number of samples, so the last step may not fit).
    expect(values.length).toBeGreaterThanOrEqual(239);
    expect(values.length).toBeLessThanOrEqual(240);
    const before = values.slice(10, 70).reduce((sum, value) => sum + value, 0) / 60;
    const after = values.slice(100, 220).reduce((sum, value) => sum + value, 0) / 120;
    expect(before).toBeLessThan(0.4);
    expect(after).toBeGreaterThan(0.6);
  });

  it("puts the drop on the bar where the energy rises", () => {
    expect(analysis.drop).not.toBeNull();
    // The loud part starts at 8 s; the nearest bar line is at 8.25 s (bars every 2 s from 0.25 s).
    expect(Math.abs(analysis.drop!.atMs - 8250)).toBeLessThanOrEqual(2000);
    expect(analysis.drop!.riseDb).toBeGreaterThan(3);
  });

  it("is the same twice and round-trips through its schema", () => {
    expect(analyseAudio(track)).toEqual(analysis);
    expect(parseAudioAnalysis(JSON.parse(JSON.stringify(analysis)))).toEqual(analysis);
    expect(parseAudioAnalysis({ ...analysis, version: 2 })).toBeNull();
  });

  it("gives the music fields a reel stores", () => {
    const fields = musicFieldsFromAnalysis(analysis);
    expect(fields.bpm).toBe(analysis.bpm);
    expect(fields.downbeats).toEqual(analysis.downbeats);
  });

  it("finds no pulse and no drop in silence", () => {
    const flat = analyseAudio(new Float32Array(BEAT_SAMPLE_RATE * 12));
    expect(flat.bpm).toBeNull();
    expect(flat.beats).toEqual([]);
    expect(flat.downbeats).toEqual([]);
    expect(flat.drop).toBeNull();
    expect(flat.energy.values.every((value) => value === 0)).toBe(true);
  });
});

describe("findDrop", () => {
  it("takes the earliest of the large rises, on a candidate", () => {
    // 100 ms steps: quiet (−40 dB) for 4 s, then −30 dB for 4 s, then −29 dB (a second, smaller rise).
    const db = [...Array(40).fill(-40), ...Array(40).fill(-30), ...Array(40).fill(-29)];
    expect(findDrop(db, 100, [1000, 2000, 4000, 8000])).toEqual({ atMs: 4000, riseDb: 10 });
    // Without candidates every step is one: the earliest step whose two-second windows show the rise (within 1 dB of the largest).
    const free = findDrop(db, 100, [])!;
    expect(free.atMs).toBeGreaterThanOrEqual(3800);
    expect(free.atMs).toBeLessThanOrEqual(4000);
  });

  it("is null when nothing rises by 3 dB", () => {
    expect(findDrop(Array(80).fill(-30), 100, [2000, 4000])).toBeNull();
  });
});

describe("energyCurve and beats in reel time", () => {
  it("normalises and smooths", () => {
    const curve = energyCurve([-60, -60, -60, -20, -20, -20]);
    expect(curve[0]).toBe(0);
    expect(curve[5]).toBe(1);
    expect(curve[2]).toBeCloseTo(1 / 3, 2);
  });

  it("moves beats into reel time for a reel that starts into the song", () => {
    const grid = { bpm: 120, offsetMs: 250 };
    expect(beatsOf(grid, 2100)).toEqual([250, 750, 1250, 1750]);
    expect(reelBeats({ ...grid, beatOffsetMs: 250, beats: [] }, 1000, 2000)).toEqual([250, 750, 1250, 1750]);
    expect(reelBeats({ bpm: null, beatOffsetMs: null, beats: [] }, 0, 2000)).toEqual([]);
  });
});
