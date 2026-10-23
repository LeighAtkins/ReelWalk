import { describe, expect, it } from "vitest";
import { analyseAudio, AUDIO_ANALYSIS_VERSION, audioTrace, BEAT_SAMPLE_RATE, beatDistanceMs, clipSchema, emptyTimeline, parseTimeline, type AudioAnalysis, type Timeline } from "../src";

const clip = (id: string, ms: number, extra: Record<string, unknown> = {}) => clipSchema.parse({ id, assetId: id, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: ms, ...extra });
const talk = { text: "hello there", words: [{ w: "hello", s: 500, e: 800 }, { w: "there", s: 900, e: 1200 }] };

/** A 120 bpm analysis with beats every 500 ms from 0 and a drop at 4 s. */
const analysis: AudioAnalysis = {
  version: AUDIO_ANALYSIS_VERSION,
  durationMs: 30_000,
  bpm: 120,
  beatOffsetMs: 0,
  beats: Array.from({ length: 60 }, (_, i) => i * 500),
  downbeats: Array.from({ length: 15 }, (_, i) => i * 2000),
  sections: [],
  energy: { stepMs: 100, values: [] },
  drop: { atMs: 4000, riseDb: 6 },
};

describe("audioTrace", () => {
  it("lists beats, cuts, speech and sounds in reel time, and flags a cut off the beat", () => {
    // Cuts at 2000 (on a beat) and 3100 (100 ms off), speech in the second clip, a whoosh.
    const timeline: Timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("a", 2000), clip("b", 1100), clip("c", 2900)], music: { assetId: "song", instagramAudioId: "123", bpm: 120, beatOffsetMs: 0, volume: 0.8 }, sfx: [{ id: "w", sound: "whoosh-1", atMs: 1700, reason: "whoosh" }] });
    const trace = audioTrace({ timeline, analysis, transcripts: { b: talk } });
    expect(trace.durationMs).toBe(6000);
    expect(trace.music).toEqual({ kind: "instagram", bpm: 120, sourceStartMs: 0, analysed: true });
    expect(trace.beats.slice(0, 3)).toEqual([0, 500, 1000]);
    expect(trace.beats.at(-1)).toBe(6000);
    expect(trace.downbeats).toEqual([0, 2000, 4000, 6000]);
    expect(trace.dropMs).toBe(4000);
    expect(trace.cuts).toEqual([
      { atMs: 2000, clipId: "b", transition: "cut", offBeatMs: 0 },
      { atMs: 3100, clipId: "c", transition: "cut", offBeatMs: 100 },
    ]);
    // "there" runs to 1200 ms of a 1100 ms clip: clamped to the cut, then padded.
    expect(trace.speech).toEqual([{ startMs: 2350, endMs: 3250 }]);
    expect(trace.sfx).toEqual([{ id: "w", sound: "whoosh-1", atMs: 1700, endMs: 2400, reason: "whoosh" }]);
    expect(trace.problems.map((problem) => problem.kind)).toEqual(["cut-off-beat", "drop-mid-shot"]);
    expect(trace.problems[0]).toMatchObject({ atMs: 3100, clipId: "c", severity: "medium" });
    // Speech in the export: the Instagram sound goes under the voice.
    expect(trace.recommended).toMatchObject({ audioVolume: 40, videoVolume: 100 });
  });

  it("falls back to the reel's own grid when the track has no analysis", () => {
    const timeline: Timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("a", 2000), clip("b", 2000)], music: { assetId: "song", bpm: 120, beatOffsetMs: 250, sourceStartMs: 0, volume: 0.8 } });
    const trace = audioTrace({ timeline, analysis: null, transcripts: {} });
    expect(trace.music.analysed).toBe(false);
    expect(trace.beats.slice(0, 2)).toEqual([250, 750]);
    expect(trace.dropMs).toBeNull();
    expect(trace.cuts[0].offBeatMs).toBe(250);
  });

  it("flags loud own music under speech and a silent hole in a rendered export", () => {
    const timeline: Timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("a", 2000), clip("b", 4000)], music: { assetId: "song", bpm: null, beatOffsetMs: null, sourceStartMs: 0, volume: 1 } });
    const loudness = { stepMs: 250, lufs: [...Array(8).fill(-18), ...Array(8).fill(-60), ...Array(8).fill(-18)], integratedLufs: -18, truePeakDb: -2 };
    const trace = audioTrace({ timeline, analysis: null, transcripts: { a: talk }, loudness });
    expect(trace.beats).toEqual([]);
    expect(trace.problems.map((problem) => problem.kind)).toEqual(["speech-under-music", "silence"]);
    expect(trace.problems[1]).toMatchObject({ atMs: 2000, endMs: 4000 });
    expect(trace.loudness).toBe(loudness);
  });

  it("does not call an Instagram-sound reel's quiet export a hole, and recommends the sound alone when the export is silent", () => {
    const timeline: Timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("a", 2000, { volume: 0 }), clip("b", 2000, { volume: 0 })], music: { assetId: "song", instagramAudioId: "1", bpm: null, beatOffsetMs: null, volume: 0.8 } });
    const loudness = { stepMs: 250, lufs: Array(16).fill(-80), integratedLufs: null, truePeakDb: null };
    const trace = audioTrace({ timeline, analysis: null, transcripts: {}, loudness });
    expect(trace.problems).toEqual([]);
    expect(trace.recommended).toMatchObject({ audioVolume: 100, videoVolume: 0 });
  });

  it("measures the distance to the nearest beat", () => {
    expect(beatDistanceMs([0, 500, 1000], 480)).toBe(20);
    expect(beatDistanceMs([], 480)).toBeNull();
  });

  it("runs on a real analysis of a click track end to end", () => {
    const samples = new Float32Array(BEAT_SAMPLE_RATE * 12);
    const period = (60 / 120) * BEAT_SAMPLE_RATE;
    for (let beat = 0; beat < samples.length; beat += period) for (let i = 0; i < 300 && beat + i < samples.length; i++) samples[Math.floor(beat) + i] = (1 - i / 300) * (i % 2 ? 0.5 : -0.5);
    const real = analyseAudio(samples);
    const timeline: Timeline = parseTimeline({ ...emptyTimeline(), clips: [clip("a", 2000), clip("b", 2000)], music: { assetId: "song", instagramAudioId: "1", bpm: real.bpm, beatOffsetMs: real.beatOffsetMs, volume: 0.8 } });
    const trace = audioTrace({ timeline, analysis: real, transcripts: {} });
    expect(trace.beats.length).toBeGreaterThan(5);
    expect(trace.cuts[0].offBeatMs).toBeLessThan(60);
  });
});
