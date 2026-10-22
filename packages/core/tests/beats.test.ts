import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addClips,
  BEAT_SAMPLE_RATE,
  beatOnsets,
  clipDurationMs,
  clipStartsMs,
  detectBeats,
  detectBeatsFromOnsets,
  emptyTimeline,
  nearestBeatMs,
  setMusic,
  snapCutsToBeats,
  type Clip,
} from "../src";

/** A click track: a short burst of noise on every beat. */
function clicks(bpm: number, offsetMs: number, seconds: number): Float32Array {
  const samples = new Float32Array(BEAT_SAMPLE_RATE * seconds);
  const period = (60 / bpm) * BEAT_SAMPLE_RATE;
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let beat = (offsetMs / 1000) * BEAT_SAMPLE_RATE; beat < samples.length; beat += period) {
    for (let i = 0; i < 400 && beat + i < samples.length; i++) samples[Math.floor(beat) + i] = noise() * (1 - i / 400);
  }
  return samples;
}

/** A burst of noise at `at` samples, `gain` loud, fading over `length` samples. */
function burst(samples: Float32Array, at: number, gain: number, length: number, noise: () => number): void {
  for (let i = 0; i < length && Math.floor(at) + i < samples.length; i++) samples[Math.floor(at) + i] += noise() * gain * (1 - i / length);
}

function seeded(seed: number): () => number {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/**
 * Kicks on every beat with a louder hat every dotted eighth (three
 * sixteenths): the 4:3 layer of a dance track. Until the harmonic check the
 * detector read this at 4/3 of the tempo (160 for 120), as it did the real
 * track in the fixture below.
 */
function dottedHats(bpm: number, offsetMs: number, seconds: number, hatGain: number): Float32Array {
  const rate = BEAT_SAMPLE_RATE;
  const samples = new Float32Array(rate * seconds);
  const period = (60 / bpm) * rate;
  const noise = seeded(5);
  for (let at = (offsetMs / 1000) * rate; at < samples.length; at += period) burst(samples, at, 0.5, 400, noise);
  for (let at = (offsetMs / 1000) * rate; at < samples.length; at += period * 0.75) burst(samples, at, hatGain, 300, noise);
  return samples;
}

/** Kicks on every beat with a louder 3+3+2 (tresillo) of hats restarting every two beats. Read as 96 bpm before the harmonic check. */
function tresillo(bpm: number, offsetMs: number, seconds: number, hatGain: number): Float32Array {
  const rate = BEAT_SAMPLE_RATE;
  const samples = new Float32Array(rate * seconds);
  const period = (60 / bpm) * rate;
  const noise = seeded(3);
  let beat = 0;
  for (let at = (offsetMs / 1000) * rate; at < samples.length; at += period, beat++) {
    burst(samples, at, 0.5, 400, noise);
    if (beat % 2 === 0) {
      burst(samples, at + period * 0.75, hatGain, 300, noise);
      burst(samples, at + period * 1.5, hatGain, 300, noise);
    }
  }
  return samples;
}

/** Distance from the detected first beat to the nearest beat of the true grid, in ms. */
function phaseErrorMs(offsetMs: number, trueOffsetMs: number, periodMs: number): number {
  const phase = ((((offsetMs - trueOffsetMs) % periodMs) + periodMs) % periodMs);
  return Math.min(phase, periodMs - phase);
}

function clip(id: string, kind: "IMAGE" | "VIDEO", durationMs: number): Clip {
  return {
    id,
    assetId: id,
    kind,
    sourceStartMs: 0,
    sourceEndMs: durationMs,
    speed: 1,
    volume: 1,
    zoom: 1,
    fit: "cover",
    filter: "none",
    motion: "none",
    transitionIn: "cut",
    pano: null,
    spot: null,
    room: null,
  };
}

describe("detectBeats", () => {
  it("finds the tempo and the first beat of a click track", () => {
    const grid = detectBeats(clicks(120, 250, 20));
    expect(grid?.bpm).toBeCloseTo(120, 0);
    // Where the beats fall, give or take one analysis window (23 ms).
    const phase = ((grid!.offsetMs - 250) % 500 + 500) % 500;
    expect(Math.min(phase, 500 - phase)).toBeLessThan(40);
  });

  it("tells tempos apart", () => {
    expect(detectBeats(clicks(96, 0, 20))?.bpm).toBeCloseTo(96, 0);
    expect(detectBeats(clicks(140, 100, 20))?.bpm).toBeCloseTo(140, 0);
  });

  it("returns null for silence and for audio that is too short", () => {
    expect(detectBeats(new Float32Array(BEAT_SAMPLE_RATE * 20))).toBeNull();
    expect(detectBeats(clicks(120, 0, 2))).toBeNull();
  });

  it("is not fooled into 4/3 of the tempo by dotted-eighth hats, even louder ones", () => {
    for (const hatGain of [0.4, 0.7, 1.1]) {
      const grid = detectBeats(dottedHats(120, 250, 24, hatGain));
      expect(grid?.bpm, `hats at ${hatGain}`).toBeCloseTo(120, 0);
      expect(phaseErrorMs(grid!.offsetMs, 250, 500), `phase with hats at ${hatGain}`).toBeLessThan(40);
    }
  });

  it("is not fooled by a tresillo (3+3+2) of louder hats", () => {
    for (const hatGain of [0.5, 0.9]) {
      const grid = detectBeats(tresillo(120, 250, 24, hatGain));
      expect(grid?.bpm, `hats at ${hatGain}`).toBeCloseTo(120, 0);
      expect(phaseErrorMs(grid!.offsetMs, 250, 500), `phase with hats at ${hatGain}`).toBeLessThan(40);
    }
  });

  it("reads the Fresh Dance Club preview at 120 bpm with the beats where they are (was 160 bpm, a 4:3 lock)", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/fresh-dance-club.onsets.json", import.meta.url), "utf8")) as {
      framesPerSecond: number;
      truth: { bpm: number; beatOffsetMs: number };
      onsets: number[];
    };
    const grid = detectBeatsFromOnsets(Float32Array.from(fixture.onsets), fixture.framesPerSecond);
    expect(grid?.bpm).toBeCloseTo(fixture.truth.bpm, 0);
    expect(phaseErrorMs(grid!.offsetMs, fixture.truth.beatOffsetMs, 60_000 / fixture.truth.bpm)).toBeLessThan(40);
  });

  it("makes the same onset curve the fixture holds: one value per 256 samples", () => {
    const onsets = beatOnsets(clicks(120, 0, 2));
    expect(onsets.length).toBe(Math.floor((BEAT_SAMPLE_RATE * 2) / 256));
    expect(Math.max(...onsets)).toBeGreaterThan(0);
  });
});

describe("snapCutsToBeats", () => {
  const music = { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 120, beatOffsetMs: 0 };

  it("finds the nearest beat", () => {
    expect(nearestBeatMs(1240, { bpm: 120, offsetMs: 0 })).toBe(1000);
    expect(nearestBeatMs(1260, { bpm: 120, offsetMs: 0 })).toBe(1500);
    expect(nearestBeatMs(1000, { bpm: 120, offsetMs: 100 }, 0)).toBe(1100);
  });

  it("moves every cut onto a beat", () => {
    const timeline = setMusic(addClips(emptyTimeline(), [clip("a", "IMAGE", 3200), clip("b", "IMAGE", 2700), clip("c", "IMAGE", 4100)]), music);
    const snapped = snapCutsToBeats(timeline);
    const cuts = clipStartsMs(snapped).slice(1);
    expect(cuts.every((cut) => cut % 500 === 0)).toBe(true);
    // 3200 -> 3000; then 3000 + 2700 = 5700 is nearer 5500 than 6000; then 5500 + 4100 -> 9500.
    expect(snapped.clips.map(clipDurationMs)).toEqual([3000, 2500, 4000]);
  });

  it("accounts for where in the song the reel starts", () => {
    const timeline = setMusic(addClips(emptyTimeline(), [clip("a", "IMAGE", 3000), clip("b", "IMAGE", 3000)]), { ...music, sourceStartMs: 200 });
    // Beats on the reel now fall at 300, 800, 1300, ...
    expect(clipStartsMs(snapCutsToBeats(timeline))[1]).toBe(2800);
  });

  it("never stretches a video past the end of its source", () => {
    const timeline = setMusic(addClips(emptyTimeline(), [clip("v", "VIDEO", 2800), clip("b", "IMAGE", 3000)]), music);
    const snapped = snapCutsToBeats(timeline, { v: 2800 });
    expect(clipDurationMs(snapped.clips[0])).toBe(2500);
  });

  it("does nothing without music or without a known tempo", () => {
    const noMusic = addClips(emptyTimeline(), [clip("a", "IMAGE", 3200)]);
    expect(snapCutsToBeats(noMusic)).toBe(noMusic);
    const noTempo = setMusic(noMusic, { ...music, bpm: null });
    expect(snapCutsToBeats(noTempo)).toBe(noTempo);
  });
});
