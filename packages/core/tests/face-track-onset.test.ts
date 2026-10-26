import { describe, expect, it } from "vitest";
import { levelsDb, snapWordsToVoice, trackFace, voicedStretches, type Gray } from "../src";

// ADR 0089 round 3: the face followed through a take, and whisper's word starts put back on the voice.

/** A grey frame with a textured face-sized patch (a checker of random-ish tones) centred at (cx, cy) px. */
function frame(width: number, height: number, cx: number, cy: number, size: number): Gray {
  const data = new Float32Array(width * height).fill(90);
  for (let y = Math.round(cy - size / 2); y < cy + size / 2; y++) {
    for (let x = Math.round(cx - size / 2); x < cx + size / 2; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const u = Math.floor((x - cx + size) / 4), v = Math.floor((y - cy + size) / 4);
      data[y * width + x] = 40 + ((u * 37 + v * 91 + u * v * 13) % 7) * 30;
    }
  }
  return { width, height, data };
}

describe("trackFace", () => {
  it("follows a face patch that moves and keeps its box the same size", () => {
    const W = 180, H = 320, size = 60;
    const centres = Array.from({ length: 12 }, (_, i) => [70 + i * 2, 120 + i * 1.5] as const);
    const frames = centres.map(([x, y]) => frame(W, H, x, y, size));
    const seed = { x0: (70 - size / 2) / W, y0: (120 - size / 2) / H, x1: (70 + size / 2) / W, y1: (120 + size / 2) / H };
    const samples = trackFace(frames, frames.map((_, i) => i * 100), seed)!;
    expect(samples).not.toBeNull();
    const last = samples[samples.length - 1];
    const [cx, cy] = centres[last.ms / 100];
    // Within a pixel of a 180×320 frame.
    expect(Math.abs(((last.x0 + last.x1) / 2) * W - cx)).toBeLessThan(1);
    expect(Math.abs(((last.y0 + last.y1) / 2) * H - cy)).toBeLessThan(1);
    expect((last.x1 - last.x0) / (seed.x1 - seed.x0)).toBeCloseTo(1, 1);
  });

  it("refuses a seed on a blank area instead of guessing", () => {
    const frames = Array.from({ length: 5 }, () => ({ width: 180, height: 320, data: new Float32Array(180 * 320).fill(90) }));
    expect(trackFace(frames, [0, 100, 200, 300, 400], { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.4 })).toBeNull();
  });
});

describe("speech onsets", () => {
  /** Levels every 10 ms: quiet room tone at −45 dB with voiced stretches at −18 dB. */
  const levels = (stretches: [number, number][], totalMs = 4000) =>
    Array.from({ length: totalMs / 10 }, (_, i) => (stretches.some(([a, b]) => i * 10 >= a && i * 10 < b) ? -18 : -45));

  it("finds voiced stretches, bridging short gaps and dropping clicks", () => {
    expect(voicedStretches(levels([[800, 1000], [1100, 1500], [2000, 2040], [2500, 3000]]))).toEqual([{ startMs: 800, endMs: 1500 }, { startMs: 2500, endMs: 3000 }]);
    expect(voicedStretches(Array(300).fill(-40))).toEqual([]);
  });

  it("moves a late phrase back onto the voice as a whole (the pier take: \"Before you list,\" all 0.25 s late)", () => {
    const voiced = voicedStretches(levels([[830, 1490], [1960, 3000]]));
    const words = [{ w: "Before", s: 1080, e: 1300 }, { w: "you", s: 1300, e: 1660 }, { w: "list,", s: 1660, e: 1920 }, { w: "Ask", s: 2080, e: 2300 }];
    expect(snapWordsToVoice(words, voiced).map((w) => w.s)).toEqual([830, 1050, 1410, 1960]);
  });

  it("moves a word that starts in a silence forward to the voice, and leaves words alone without a voice track", () => {
    const voiced = voicedStretches(levels([[500, 900], [1500, 2200]]));
    const words = [{ w: "Hi.", s: 500, e: 800 }, { w: "Look", s: 1300, e: 1700 }];
    expect(snapWordsToVoice(words, voiced)[1].s).toBe(1500);
    expect(snapWordsToVoice(words, [])).toEqual(words);
  });

  it("reads loudness from samples", () => {
    const loud = Float32Array.from({ length: 1600 }, (_, i) => (i % 2 ? 0.5 : -0.5));
    expect(levelsDb(loud, 16000)[0]).toBeCloseTo(-6.02, 1);
  });
});
