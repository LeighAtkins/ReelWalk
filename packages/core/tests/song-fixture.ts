import { BEAT_SAMPLE_RATE } from "../src";

/**
 * A generated song with a known structure, for the song-map and pacing tests:
 * a kick on the first beat of every bar, a click on the others, after a
 * `leadMs` of silence. The intro is quiet clicks; the build grows louder and
 * adds eighth-note hats; the drop is loud with sixteenth hats and a noise
 * bed; the outro is quiet again. Deterministic (a fixed-seed noise source).
 */
export type Part = { kind: "intro" | "build" | "drop" | "outro"; bars: number };
export const SONG_PARTS: Part[] = [
  { kind: "intro", bars: 8 },
  { kind: "build", bars: 8 },
  { kind: "drop", bars: 8 },
  { kind: "outro", bars: 4 },
];

export function clickSong({ bpm = 120, leadMs = 250, parts = SONG_PARTS, sampleRate = BEAT_SAMPLE_RATE } = {}): { samples: Float32Array; barMs: number; leadMs: number; partStartsMs: number[] } {
  const beatS = 60 / bpm;
  const bars = parts.reduce((sum, part) => sum + part.bars, 0);
  const seconds = leadMs / 1000 + bars * 4 * beatS + 0.5;
  const samples = new Float32Array(Math.ceil(seconds * sampleRate));
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (atS: number, lengthS: number, gain: number, wave: (i: number, n: number) => number) => {
    const start = Math.floor(atS * sampleRate);
    const n = Math.floor(lengthS * sampleRate);
    for (let i = 0; i < n && start + i < samples.length; i++) samples[start + i] += gain * wave(i, n);
  };
  const kick = (i: number, n: number) => Math.sin((2 * Math.PI * 60 * i) / sampleRate) * (1 - i / n) ** 2;
  const click = (i: number, n: number) => Math.sin((2 * Math.PI * 1800 * i) / sampleRate) * (1 - i / n);
  const hat = (i: number, n: number) => noise() * (1 - i / n);

  let bar = 0;
  const partStartsMs: number[] = [];
  for (const part of parts) {
    partStartsMs.push(leadMs + bar * 4 * beatS * 1000);
    for (let b = 0; b < part.bars; b++, bar++) {
      const progress = b / Math.max(1, part.bars - 1);
      const gain = part.kind === "intro" || part.kind === "outro" ? 0.2 : part.kind === "build" ? 0.4 + 0.3 * progress : 1;
      for (let beat = 0; beat < 4; beat++) {
        const at = leadMs / 1000 + (bar * 4 + beat) * beatS;
        if (beat === 0) add(at, 0.12, gain, kick);
        else add(at, 0.03, gain * 0.45, click);
        if (part.kind === "build") add(at + beatS / 2, 0.012, gain * 0.25, hat);
        if (part.kind === "drop") {
          for (let s = 1; s < 4; s++) add(at + (s * beatS) / 4, 0.012, 0.3, hat);
          add(at, beatS, 0.08, () => noise());
        }
      }
    }
  }
  return { samples, barMs: 4 * beatS * 1000, leadMs, partStartsMs };
}
