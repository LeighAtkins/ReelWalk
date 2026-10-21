import { describe, expect, it } from "vitest";
import {
  analyseSong,
  applyCommand,
  clipEnergyFromMotion,
  clipStartsMs,
  detectBeats,
  nearestDownbeatMs,
  paceTimeline,
  parseTimeline,
  particleField,
  planPace,
  putOnTheBeat,
  reelGrid,
  textAttachment,
  timelineDurationMs,
  type CommandContext,
  type Music,
  type Timeline,
} from "../src";
import { clickSong } from "./song-fixture";

// Editing to the beat (ADR 0059): the cut plan, "On the beat", and the pace command.

const BAR = 2000;
const BEAT = 500;
/** 120 bpm, first beat at 250 ms; intro 0–16.25 s, build to 32.25 s, drop to 48.25 s, then the outro. */
const songMap = {
  bpm: 120,
  beatOffsetMs: 250,
  downbeats: Array.from({ length: 28 }, (_, bar) => 250 + bar * BAR),
  sections: [
    { kind: "intro" as const, startMs: 0, endMs: 16250 },
    { kind: "build" as const, startMs: 16250, endMs: 32250 },
    { kind: "drop" as const, startMs: 32250, endMs: 48250 },
    { kind: "outro" as const, startMs: 48250, endMs: 56750 },
  ],
};
/** The reel starts 8.25 s into the song: intro to 8 s, build to 24 s, the drop at 24 s. */
const music = { assetId: "song", sourceStartMs: 8250, volume: 0.8, ...songMap };
const DROP_MS = 24000;

const durations: Record<string, number> = { song: 60000 };
const ids = Array.from({ length: 14 }, (_, i) => `c${i}`);
for (const id of ids) durations[`v-${id}`] = 30000;

function reel(extra: Partial<Music> = {}): Timeline {
  return parseTimeline({
    version: 1,
    clips: ids.map((id, i) => (i % 3 === 2 ? { id, assetId: `p-${id}`, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 } : { id, assetId: `v-${id}`, kind: "VIDEO", sourceStartMs: 4000, sourceEndMs: 7000 })),
    texts: [
      // Inside c4 (12–15 s), 400 ms in: attached to c4.
      { id: "kitchen", text: "Kitchen", startMs: 12400, endMs: 14400, style: "elegant" },
      // Across several cuts: reel-relative.
      { id: "caption", text: "Just listed", startMs: 1000, endMs: 20000, style: "tag", y: 0.3, size: 0.6 },
    ],
    music: { ...music, ...extra },
  });
}
// c7 moves most: the hero.
const clipEnergy = Object.fromEntries(ids.map((id, i) => [id, i === 7 ? 0.95 : 0.3 + (i % 4) * 0.05]));
const ctx: CommandContext = { generation: 0, sourceDurationsMs: durations };
// In reel time (the song starts 8.25 s in, its first beat at 0.25 s) beats fall on multiples of 500 ms and bars on multiples of 2 s.
const near = (ms: number, step: number) => Math.min(((ms % step) + step) % step, step - (((ms % step) + step) % step)) <= 1;
const onBeat = (ms: number) => near(ms, BEAT);
const onBar = (ms: number) => near(ms, BAR);

describe("planPace", () => {
  it("is deterministic", () => {
    const a = planPace(reel(), { energy: 0.5, clipEnergy, sourceDurationsMs: durations });
    const b = planPace(reel(), { energy: 0.5, clipEnergy, sourceDurationsMs: durations });
    expect(a).toEqual(b);
    expect(a!.clips.map((clip) => clip.id).sort()).toEqual([...ids].sort());
  });

  it("cuts on the beat, on the bar for shots of a bar or more, and on the drop", () => {
    for (const energy of [0, 0.5, 1]) {
      const plan = planPace(reel(), { energy, clipEnergy, sourceDurationsMs: durations })!;
      const cuts = plan.shots.slice(0, -1).map((shot) => shot.endMs);
      for (const cut of cuts) expect(onBeat(cut), `cut at ${cut} (energy ${energy})`).toBe(true);
      for (const shot of plan.shots.slice(0, -1)) if (shot.beats >= 4) expect(onBar(shot.endMs), `${shot.clipId} ends ${shot.endMs}`).toBe(true);
      // At hype fourteen clips are over before the drop (18 s): the hero closes the reel instead.
      if (energy < 1) expect(cuts).toContain(DROP_MS);
      else expect(plan.shots.at(-1)).toMatchObject({ clipId: "c7", hero: true });
    }
  });

  it("puts the hero shot on the drop and holds it", () => {
    const plan = planPace(reel(), { energy: 0.5, clipEnergy, sourceDurationsMs: durations })!;
    expect(plan.heroClipId).toBe("c7");
    const hero = plan.shots.find((shot) => shot.hero)!;
    expect(hero).toMatchObject({ clipId: "c7", startMs: DROP_MS, section: "drop" });
    const others = plan.shots.filter((shot) => shot.section === "drop" && !shot.hero);
    for (const shot of others) expect(hero.endMs - hero.startMs).toBeGreaterThan(shot.endMs - shot.startMs);
  });

  it("holds longer in the intro than in the build, and hype cuts faster than chill", () => {
    const mean = (energy: number, section: string) => {
      const shots = planPace(reel(), { energy, clipEnergy, sourceDurationsMs: durations })!.shots.filter((shot) => shot.section === section && !shot.hero);
      return shots.reduce((sum, shot) => sum + shot.endMs - shot.startMs, 0) / shots.length;
    };
    for (const energy of [0, 0.5, 1]) expect(mean(energy, "intro")).toBeGreaterThan(mean(energy, "build"));
    const total = (energy: number) => timelineDurationMs({ ...reel(), clips: planPace(reel(), { energy, clipEnergy, sourceDurationsMs: durations })!.clips });
    expect(total(1)).toBeLessThan(total(0.5));
    expect(total(0.5)).toBeLessThan(total(0));
  });

  it("leaves the order alone when nothing was measured to tell the clips apart", () => {
    const plan = planPace(reel(), { energy: 0.5, sourceDurationsMs: { ...durations } })!;
    // Videos (0.5) and photos (0.15) differ, so the first video moves; with all photos nothing does.
    expect(plan.heroClipId).not.toBeNull();
    const photos = parseTimeline({ ...reel(), clips: reel().clips.map((clip) => ({ ...clip, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 })) });
    expect(planPace(photos, { energy: 0.5 })!.clips.map((clip) => clip.id)).toEqual(ids);
  });

  it("never plays a video past its source", () => {
    const short = { ...durations, "v-c0": 1200 };
    const plan = planPace(reel(), { energy: 0, clipEnergy, sourceDurationsMs: short })!;
    const c0 = plan.clips.find((clip) => clip.id === "c0")!;
    expect(c0.sourceEndMs).toBeLessThanOrEqual(1200);
    expect(c0.sourceStartMs).toBeGreaterThanOrEqual(0);
  });

  it("does nothing without a tempo", () => {
    const timeline = reel({ bpm: null });
    expect(planPace(timeline, { energy: 1 })).toBeNull();
    expect(paceTimeline(timeline, { energy: 1 })).toBe(timeline);
  });

  it("plans the generated song end to end", () => {
    const song = clickSong();
    const grid = detectBeats(song.samples)!;
    const map = analyseSong(song.samples, grid);
    const timeline = parseTimeline({ ...reel(), music: { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: grid.bpm, beatOffsetMs: grid.offsetMs, ...map } });
    const plan = planPace(timeline, { energy: 0, clipEnergy, sourceDurationsMs: durations })!;
    const drop = map.sections.find((section) => section.kind === "drop")!;
    const hero = plan.shots.find((shot) => shot.hero);
    // Fourteen clips at chill reach the drop (32 s in), and the hero lands on it.
    expect(hero?.startMs).toBe(drop.startMs);
  });
});

describe("the pace command", () => {
  it("is one change; titles attached to a clip follow it and captions keep their seconds", () => {
    const before = reel({ onBeat: false });
    const result = applyCommand(before, { type: "pace", energy: 0.5, clipEnergy }, ctx);
    expect(result.rejected).toBeUndefined();
    const after = result.timeline;
    expect(after.music?.energy).toBe(0.5);
    const kitchen = after.texts.find((text) => text.id === "kitchen")!;
    const at = after.clips.findIndex((clip) => clip.id === "c4");
    const start = clipStartsMs(after)[at];
    expect(textAttachment(after, kitchen)).toEqual({ kind: "clip", clipId: "c4" });
    // Same picture: c4's source moved to keep its middle, so the title sits where that frame now plays.
    const was = before.clips[4];
    const now = after.clips[at];
    expect(kitchen.startMs - start).toBe(Math.max(0, 400 - (now.sourceStartMs - was.sourceStartMs)));
    expect(after.texts.find((text) => text.id === "caption")).toMatchObject({ startMs: 1000, endMs: 20000 });
  });

  it("plans from the reel before the gesture, so dragging back gives back the same cut", () => {
    const base = reel();
    const hype = applyCommand(base, { type: "pace", energy: 1, clipEnergy }, ctx).timeline;
    const chillAfterHype = applyCommand(hype, { type: "pace", energy: 0, clipEnergy }, { ...ctx, gestureBase: base }).timeline;
    const chill = applyCommand(base, { type: "pace", energy: 0, clipEnergy }, ctx).timeline;
    expect(chillAfterHype).toEqual(chill);
  });

  it("brings the song's map with it when the song had none", () => {
    const bare = reel({ downbeats: undefined, sections: undefined });
    const { timeline } = applyCommand(bare, { type: "pace", energy: 0.5, clipEnergy, songMap: { downbeats: songMap.downbeats, sections: songMap.sections } }, ctx);
    expect(timeline.music?.sections).toEqual(songMap.sections);
    expect(timeline).toEqual(applyCommand(reel(), { type: "pace", energy: 0.5, clipEnergy }, ctx).timeline);
  });
});

describe("On the beat", () => {
  const grid = reelGrid(reel().music)!;

  it("rounds to the nearest downbeat of the reel", () => {
    expect(nearestDownbeatMs(grid, 2900)).toBe(2000);
    expect(nearestDownbeatMs(grid, 3100)).toBe(4000);
  });

  it("moves entrances, bursts and the pass onto the bar, and leaves what is not set", () => {
    const timeline = parseTimeline({
      ...reel({ onBeat: true }),
      texts: [
        { id: "kitchen", text: "Kitchen", startMs: 12400, endMs: 14400, style: "elegant", particles: { kind: "snow", burstMs: 13700 } },
        { id: "pass", text: "Hall", startMs: 3300, endMs: 8800, behind: true, passMs: 6300 },
        { id: "far", text: "Garden", startMs: 21200, endMs: 23000, behind: true, passMs: 22900 },
      ],
    });
    const after = putOnTheBeat(timeline, durations);
    const of = (id: string) => after.texts.find((text) => text.id === id)!;
    expect(of("kitchen")).toMatchObject({ startMs: 12000, endMs: 14000, particles: { kind: "snow", burstMs: 14000 } });
    expect(of("pass")).toMatchObject({ startMs: 4000, endMs: 9500, passMs: 6000 });
    // 22.9 s is 0.9 s from the nearest bar inside the title: more than a beat, so the pass stays where she crosses.
    expect(of("far").passMs).toBe(22900);
    expect(of("far").startMs).toBe(22000);
    expect(of("kitchen").particles?.seed).toBeUndefined();
  });

  it("keeps a title over its own clip", () => {
    // c1 plays 3–6 s; the nearest bar to 5.5 s is 6 s, which is c2's: the entrance goes to 4 s instead.
    const timeline = parseTimeline({ ...reel({ onBeat: true }), texts: [{ id: "t", text: "Hall", startMs: 5500, endMs: 5900 }] });
    const after = putOnTheBeat(timeline);
    expect(after.texts[0]).toMatchObject({ startMs: 4000, endMs: 4400 });
    expect(textAttachment(after, after.texts[0])).toEqual({ kind: "clip", clipId: "c1" });
  });

  it("moves a whip's cut onto the bar", () => {
    const timeline = parseTimeline({ ...reel({ onBeat: true }), clips: reel().clips.map((clip, i) => (i === 2 ? { ...clip, transitionIn: "whip" } : clip)), texts: [] });
    // c2 starts at 6 s: already on a bar. Move c1 so the whip falls off the bar, then put it back on.
    const off = parseTimeline({ ...timeline, clips: timeline.clips.map((clip, i) => (i === 1 ? { ...clip, sourceEndMs: clip.sourceEndMs - 700 } : clip)) });
    expect(clipStartsMs(off)[2]).toBe(5300);
    const after = putOnTheBeat(off, durations);
    expect(clipStartsMs(after)[2]).toBe(6000);
  });

  it("is off on reels saved before it: pacing them moves no entrance", () => {
    // 1.4 s into c4; c4 keeps the middle of its source (it starts 0.5 s later), so the title is 0.9 s in after the cut.
    const texts = [{ id: "kitchen", text: "Kitchen", startMs: 13400, endMs: 14400, style: "elegant" as const }];
    const old = parseTimeline({ ...reel(), texts });
    expect(old.music?.onBeat).toBeUndefined();
    const paced = applyCommand(old, { type: "pace", energy: 0.5, clipEnergy }, ctx).timeline;
    const withBeat = applyCommand(parseTimeline({ ...reel({ onBeat: true }), texts }), { type: "pace", energy: 0.5, clipEnergy }, ctx).timeline;
    const kitchen = (timeline: Timeline) => timeline.texts.find((text) => text.id === "kitchen")!.startMs;
    expect(kitchen(paced)).toBe(12900);
    expect(kitchen(withBeat)).toBe(12000);
    expect(onBar(kitchen(withBeat))).toBe(true);
  });

  it("switching it on is one change that puts things on the bar; a new song has it on", () => {
    const timeline = parseTimeline({ ...reel(), texts: [{ id: "t", text: "Hall", startMs: 3300, endMs: 4800 }] });
    const on = applyCommand(timeline, { type: "setOnBeat", on: true }, ctx).timeline;
    expect(on.music?.onBeat).toBe(true);
    expect(on.texts[0].startMs).toBe(4000);
    const off = applyCommand(on, { type: "setOnBeat", on: false }, ctx).timeline;
    expect(off.texts[0].startMs).toBe(4000);
    const picked = applyCommand(parseTimeline({ ...timeline, music: null }), { type: "setMusic", music: { assetId: "song", sourceStartMs: 0, bpm: 120, beatOffsetMs: 0 } }, ctx).timeline;
    expect(picked.music?.onBeat).toBe(true);
  });
});

describe("clip energy and bursts", () => {
  it("measures a moving shot as livelier than a still one", () => {
    const still = clipEnergyFromMotion([{ t: 0, t2: 250, dx: 0, dy: 0, change: 0.002 }]);
    const pan = clipEnergyFromMotion([{ t: 0, t2: 250, dx: 5, dy: 0, change: 0.02 }, { t: 250, t2: 500, dx: 6, dy: 1, change: 0.03 }]);
    expect(still).toBeLessThan(0.1);
    expect(pan).toBeGreaterThan(0.7);
    expect(clipEnergyFromMotion([])).toBeNull();
  });

  it("a burst changes the field only while it lasts", () => {
    const base = { kind: "snow" as const, box: { width: 600, height: 120 }, seed: 3 };
    expect(particleField({ ...base, timeMs: 5000, burstMs: 5200 })).toEqual(particleField({ ...base, timeMs: 5000 }));
    expect(particleField({ ...base, timeMs: 6200, burstMs: 5200 })).toEqual(particleField({ ...base, timeMs: 6200 }));
    expect(particleField({ ...base, timeMs: 5320, burstMs: 5200 })).not.toEqual(particleField({ ...base, timeMs: 5320 }));
  });
});
