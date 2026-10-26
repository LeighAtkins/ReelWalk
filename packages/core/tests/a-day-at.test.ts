import { describe, expect, it } from "vitest";
import { applyCommand, cutBeatMs, emptyTimeline, findBreaks, findReentry, parseTimeline, phaseFromColour, planDayAt, type Clip, type DayMusic, type DayShot, type Timeline } from "../src";

/** A song's energy curve (100 ms steps): loud, with a two-second stop at `breakAt` s and a return. */
function song(seconds: number, breakAt?: number): DayMusic {
  const values = Array.from({ length: seconds * 10 }, (_, i) => {
    const t = i / 10;
    if (breakAt != null && t >= breakAt && t < breakAt + 2) return 0.1;
    if (breakAt != null && t >= breakAt + 2 && t < breakAt + 2.4) return 0.6;
    return 0.85 + 0.05 * Math.sin(i);
  });
  return { assetId: "song", bpm: 161.5, beatOffsetMs: 170, durationMs: seconds * 1000, energy: { stepMs: 100, values } };
}

const clip = (id: string): Clip => parseTimeline({ ...emptyTimeline(), clips: [{ id, assetId: `a-${id}`, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 }], texts: [] }).clips[0];
const shot = (id: string, role: "wide" | "detail", phase: DayShot["phase"], extra: Partial<DayShot> = {}): DayShot => ({ clip: clip(id), sourceDurationMs: 12_000, role, phase, ...extra });
const shots: DayShot[] = [
  shot("d1", "detail", "day"), shot("w1", "wide", "day"), shot("d2", "detail", "day"), shot("w2", "wide", "day"),
  shot("g1", "wide", "golden"), shot("g2", "detail", "golden"), shot("g3", "wide", "golden"), shot("g4", "detail", "golden"),
  shot("sky", "wide", "golden", { sky: true }), shot("hero", "wide", "dusk", { reveal: true }), shot("n1", "detail", "dusk"), shot("n2", "wide", "dusk"),
];
const base: Timeline = parseTimeline({ ...emptyTimeline(), clips: shots.map((entry) => entry.clip), texts: [] });
let n = 0;
const newId = () => `t${++n}`;

describe("the song's return (gap #6)", () => {
  it("finds a real stop after loud music and puts the cut on the return", () => {
    const breaks = findBreaks(song(60, 30).energy.values, 100);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].kind).toBe("break");
    // Found on a one-second average, so its edges move by up to half a second.
    expect(Math.abs(breaks[0].breakFromMs! - 30_000)).toBeLessThanOrEqual(600);
    expect(breaks[0].quietMs).toBeGreaterThanOrEqual(1500);
    // The return is the steepest rise, where the music comes back.
    expect(breaks[0].atMs).toBeGreaterThanOrEqual(31_800);
    expect(breaks[0].atMs).toBeLessThanOrEqual(32_400);
  });

  it("sees through a breakdown's sparse stabs (a one-second average), but not ordinary dynamics", () => {
    const values = song(60).energy.values.map((v, i) => {
      const t = i / 10;
      if (t >= 30 && t < 36) return Math.floor(t * 10) % 15 === 0 ? 0.85 : 0.55;
      return v;
    });
    const breaks = findBreaks(values, 100);
    expect(breaks).toHaveLength(1);
    expect(Math.abs(breaks[0].atMs - 36_000)).toBeLessThanOrEqual(500);
    expect(findBreaks(song(60).energy.values.map((v, i) => v - (i % 40 < 6 ? 0.08 : 0)), 100)).toEqual([]);
  });

  it("falls back to the biggest section change, then to the drop, and to nothing", () => {
    const flat = song(60);
    expect(findBreaks(flat.energy.values, 100)).toEqual([]);
    const sections = [{ kind: "intro" as const, startMs: 0, endMs: 10_000 }, { kind: "drop" as const, startMs: 10_000, endMs: 60_000 }];
    const quietIntro = { stepMs: 100, values: flat.energy.values.map((v, i) => (i < 100 ? 0.3 : v)) };
    expect(findReentry({ energy: quietIntro, sections })).toMatchObject({ kind: "section", atMs: 10_000 });
    expect(findReentry({ energy: flat.energy, drop: { atMs: 20_000 } })).toEqual({ kind: "drop", atMs: 20_000 });
    expect(findReentry({ energy: flat.energy })).toBeNull();
  });
});

describe("the a-day-at planner (recipe 5)", () => {
  it("cuts on whole beats in the 600–1000 ms band, opens on one beat and keeps the median near reel 5's 1.6 s", () => {
    expect(cutBeatMs(161.5)).toBeCloseTo(743, 0);
    expect(cutBeatMs(71.75)).toBeCloseTo(836, 0);
    const { report } = planDayAt(base, shots, song(120, 40), { credit: "Coastal & Co presents", place: "Byron Bay" }, newId);
    expect(report.shots[0].beats).toBe(1);
    expect(report.plannedOnBeat.hits).toBe(report.plannedOnBeat.of);
    expect(report.medianShotMs).toBeGreaterThanOrEqual(1400);
    expect(report.medianShotMs).toBeLessThanOrEqual(1700);
  });

  it("runs day to golden hour to dusk, alternates wides and details, and plays the sky in the break before the reveal", () => {
    const { report } = planDayAt(base, shots, song(120, 40), {}, newId);
    const phases = report.shots.map((entry) => entry.phase);
    const order = { day: 0, golden: 1, dusk: 2 };
    for (let i = 1; i < phases.length; i++) expect(order[phases[i]]).toBeGreaterThanOrEqual(order[phases[i - 1]]);
    const day = report.shots.filter((entry) => entry.phase === "day").map((entry) => entry.role);
    expect(day).toEqual(["detail", "wide", "detail", "wide"]);
    const slots = report.shots.map((entry) => entry.slot);
    expect(slots.indexOf("break")).toBe(slots.indexOf("reveal") - 1);
    expect(report.shots.find((entry) => entry.slot === "reveal")!.clipId).toBe("hero");
    expect(report.variant).toBe("faithful");
  });

  it("starts the song so its return lands on the reveal's first frame, and holds the reveal and the last shot", () => {
    const music = song(120, 40);
    const { timeline, report } = planDayAt(base, shots, music, {}, newId);
    const reentry = report.reentry!;
    expect(reentry.kind).toBe("break");
    // On the song's own beat grid, within one song beat of the detected return.
    expect(Math.abs(report.songStartMs + report.revealReelMs! - reentry.atMs)).toBeLessThanOrEqual(60_000 / music.bpm / 2 + 1);
    expect(timeline.music?.sourceStartMs).toBe(report.songStartMs);
    const reveal = report.shots.find((entry) => entry.slot === "reveal")!;
    expect(reveal.beats * report.cutBeatMs).toBeGreaterThanOrEqual(3000);
    expect(report.shots.at(-1)!.beats * report.cutBeatMs).toBeGreaterThanOrEqual(3000);
  });

  it("sets small calm centred lines, one warm grade, hard cuts and silent clips", () => {
    const { timeline } = planDayAt(base, shots, song(120, 40), { credit: "Coastal & Co presents", place: "12 Ocean Rd, Byron Bay" }, newId);
    expect(timeline.texts.map((text) => text.text)).toEqual(["COASTAL & CO PRESENTS", "12 OCEAN RD, BYRON BAY"]);
    for (const text of timeline.texts) {
      expect(text).toMatchObject({ x: 0.5, style: "elegant", animation: "fade", color: "#ffffff" });
      // Cap height 1.25–2 % of the frame at 2.77 % per unit of size.
      expect(text.size * 2.77).toBeGreaterThanOrEqual(1.25);
      expect(text.size * 2.77).toBeLessThanOrEqual(2);
    }
    expect(new Set(timeline.clips.map((entry) => entry.filter))).toEqual(new Set(["warm"]));
    expect(timeline.clips.every((entry) => entry.transitionIn === "cut" && entry.volume === 0)).toBe(true);
  });

  it("makes the daylight variant without dusk footage and says so", () => {
    const daylight = shots.map((entry) => ({ ...entry, phase: entry.phase === "dusk" ? ("golden" as const) : entry.phase, reveal: false }));
    const { report } = planDayAt(base, daylight, song(120, 40), {}, newId);
    expect(report.variant).toBe("daylight");
    expect(report.notes.join(" ")).toMatch(/will not feel like/);
  });

  it("blends day into dusk only between shots filmed from the same place", () => {
    const paired = shots.map((entry) => (entry.clip.id === "g3" || entry.clip.id === "sky" ? { ...entry, framingKey: "pool" } : entry));
    const { timeline } = planDayAt(base, paired, song(120, 40), {}, newId);
    expect(timeline.clips.filter((entry) => entry.transitionIn === "softDissolve")).toHaveLength(0);
    const dusky = paired.map((entry) => (entry.clip.id === "sky" ? { ...entry, phase: "dusk" as const, sky: false } : entry));
    const blended = planDayAt(base, dusky, song(120, 40), {}, newId).timeline;
    expect(blended.clips.every((entry) => entry.transitionIn === "cut" || entry.transitionIn === "softDissolve")).toBe(true);
  });

  it("guesses time of day from colour when not told, and refuses too little footage", () => {
    expect(phaseFromColour({ mean: [0.11, 0.0, 0.01], std: [0.1, 0.02, 0.02] })).toBe("dusk");
    expect(phaseFromColour({ mean: [0.31, -0.02, 0.06], std: [0.1, 0.02, 0.02] })).toBe("golden");
    expect(phaseFromColour({ mean: [0.49, 0.05, -0.06], std: [0.1, 0.02, 0.02] })).toBe("day");
    expect(() => planDayAt(base, shots.slice(0, 4), song(60, 30), {}, newId)).toThrow(/at least 6/);
  });

  it("is reachable as the dayAt command", () => {
    const result = applyCommand(base, { type: "dayAt", shots: shots.map((entry) => ({ role: entry.role, phase: entry.phase, reveal: entry.reveal, sky: entry.sky, clipId: entry.clip.id })), music: song(120, 40), lines: { credit: "Coastal & Co" } },
      { generation: 1, sourceDurationsMs: Object.fromEntries(shots.map((entry) => [entry.clip.assetId, 12_000])) });
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.music?.assetId).toBe("song");
    expect(result.timeline.clips.length).toBe(shots.length);
  });
});
