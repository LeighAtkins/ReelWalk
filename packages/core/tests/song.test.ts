import { describe, expect, it } from "vitest";
import { analyseSong, BEAT_SAMPLE_RATE, detectBeats, parseSongMap, sectionAt } from "../src";
import { clickSong } from "./song-fixture";

describe("analyseSong", () => {
  const song = clickSong();
  const grid = detectBeats(song.samples)!;
  const map = analyseSong(song.samples, grid);

  it("hears the tempo of the generated song", () => {
    expect(grid.bpm).toBeCloseTo(120, 0);
  });

  it("puts the downbeats on the kicks", () => {
    expect(map.downbeats.length).toBeGreaterThanOrEqual(26);
    for (const [bar, at] of map.downbeats.entries()) {
      // Bar n's kick is at lead + n bars (the first downbeat may be the first bar or, if the lead hid it, the second).
      const offset = (at - song.leadMs) / song.barMs;
      expect(Math.abs(offset - Math.round(offset))).toBeLessThan(0.03);
      if (bar > 0) expect(at - map.downbeats[bar - 1]).toBeCloseTo(song.barMs, -1);
    }
  });

  it("finds the intro, build, drop and outro within a bar", () => {
    expect(map.sections.map((section) => section.kind)).toEqual(["intro", "build", "drop", "outro"]);
    const [, build, drop, outro] = map.sections;
    expect(Math.abs(build.startMs - song.partStartsMs[1])).toBeLessThanOrEqual(song.barMs + 30);
    expect(Math.abs(drop.startMs - song.partStartsMs[2])).toBeLessThanOrEqual(30);
    expect(Math.abs(outro.startMs - song.partStartsMs[3])).toBeLessThanOrEqual(song.barMs + 30);
    // Contiguous, from the start to the end of the audio.
    expect(map.sections[0].startMs).toBe(0);
    for (let i = 1; i < map.sections.length; i++) expect(map.sections[i].startMs).toBe(map.sections[i - 1].endMs);
    expect(map.sections.at(-1)!.endMs).toBe(Math.floor((song.samples.length / BEAT_SAMPLE_RATE) * 1000));
    // Every section boundary is a downbeat.
    for (const section of map.sections.slice(1)) expect(map.downbeats).toContain(section.startMs);
  });

  it("is the same every time", () => {
    expect(analyseSong(song.samples, grid)).toEqual(map);
  });

  it("finds the bars and the drop at another tempo, after a longer lead-in", () => {
    const other = clickSong({ bpm: 97, leadMs: 900 });
    const otherGrid = detectBeats(other.samples)!;
    const otherMap = analyseSong(other.samples, otherGrid);
    expect(otherGrid.bpm).toBeCloseTo(97, 0);
    // The first beat (273 ms) is a pickup; the first bar starts on the first kick.
    expect(Math.abs(otherMap.downbeats[0] - other.leadMs)).toBeLessThan(30);
    expect(otherMap.sections.map((section) => section.kind)).toEqual(["intro", "build", "drop", "outro"]);
    expect(Math.abs(otherMap.sections[2].startMs - other.partStartsMs[2])).toBeLessThan(30);
  });

  it("finds no sections in a steady loop", () => {
    const loop = clickSong({ parts: [{ kind: "drop", bars: 16 }] });
    const loopMap = analyseSong(loop.samples, detectBeats(loop.samples)!);
    expect(loopMap.sections).toEqual([]);
    expect(loopMap.downbeats.length).toBeGreaterThanOrEqual(15);
  });

  it("reads back what it stores and rejects anything else", () => {
    expect(parseSongMap(JSON.parse(JSON.stringify(map)))).toEqual(map);
    expect(parseSongMap({ downbeats: [-1], sections: [] })).toBeNull();
    expect(parseSongMap(null)).toBeNull();
    expect(sectionAt(map.sections, map.sections[2].startMs)?.kind).toBe("drop");
  });
});
