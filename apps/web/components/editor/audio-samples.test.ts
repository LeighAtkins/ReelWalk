import { describe, expect, it } from "vitest";
import { analyseAudio, analyseSong, BEAT_SAMPLE_RATE, detectBeats } from "@reelwalk/core";
import { analyseAudioSamples } from "./audio-samples";

function samples(seconds: number, kind: "pulse" | "ambient" | "sections" | "silence") {
  const data = new Float32Array(seconds * BEAT_SAMPLE_RATE);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    const t = i / BEAT_SAMPLE_RATE;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 4294967296 - 0.5) * 0.025;
    const pulse = Math.sin(2 * Math.PI * 70 * t) * Math.exp(-(t % 0.5) * 30) * 0.7 + noise;
    data[i] = kind === "silence" ? 0 : kind === "ambient" ? (Math.sin(2 * Math.PI * 110 * t) + Math.sin(2 * Math.PI * 164.81 * t)) * 0.08 * (0.6 + 0.4 * Math.sin(t * 0.7)) + noise : pulse * (kind === "sections" ? t < 24 ? 0.08 : t < 64 ? 1 : 0.3 : 1);
  }
  return data;
}

describe("single-pass upload audio analysis", () => {
  it.each([{ seconds: 8, kind: "pulse" as const }, { seconds: 30, kind: "ambient" as const }, { seconds: 90, kind: "sections" as const }, { seconds: 8, kind: "silence" as const }])("preserves the prior beat, song-map and complete track output for $seconds-second $kind audio", ({ seconds, kind }) => {
    const data = samples(seconds, kind);
    const beat = detectBeats(data);
    const previous = { beat, songMap: beat ? analyseSong(data, beat) : null, track: analyseAudio(data) };
    const original = data.slice();
    expect(analyseAudioSamples(data)).toEqual(previous);
    expect(data).toEqual(original);
  });
});
