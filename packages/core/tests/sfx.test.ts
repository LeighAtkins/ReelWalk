import { describe, expect, it } from "vitest";
import { ambienceFor, applyCommand, autoPlaceSfx, clipSchema, emptyTimeline, inferAmbienceTag, parseTimeline, reelDropMs, SFX_SOUNDS, sfxEndMs, sfxGainAt, sfxSoundsUsed, trimSfxToReel, withSfx, type Timeline } from "../src";

const clip = (id: string, ms: number, extra: Record<string, unknown> = {}) => clipSchema.parse({ id, assetId: id, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: ms, ...extra });

/** 2 s, a saved whip (a cut since ADR 0082) into 2 s, 4 s hold, cut into 2 s: cuts at 2000, 4000, 8000. */
const reel = (): Timeline => parseTimeline({ ...emptyTimeline(), clips: [clip("a", 2000), clip("b", 2000, { transitionIn: "whip" }), clip("c", 4000, { room: "fireplace lounge" }), clip("d", 2000)] });

describe("autoPlaceSfx", () => {
  it("puts no whoosh on a retired whip, and a riser and impact into the longest hold", () => {
    const sfx = autoPlaceSfx(reel());
    // The longest hold after the opening starts at 4 s: the riser ends there, the impact lands there.
    const riser = sfx.find((clip) => clip.sound === "riser")!;
    expect(sfxEndMs(riser)).toBe(4000);
    expect(riser.atMs).toBe(1000);
    expect(sfx.find((clip) => clip.sound === "impact-soft")!.atMs).toBe(4000);
    // No whoosh on the plain cuts either.
    expect(sfx.filter((clip) => clip.sound.startsWith("whoosh"))).toHaveLength(0);
  });

  it("infers fire ambience from the room name and spans the clip, faded", () => {
    const fire = autoPlaceSfx(reel()).find((clip) => clip.sound === "fire")!;
    expect(fire).toMatchObject({ atMs: 4000, durationMs: 4000, fadeInMs: 400, fadeOutMs: 400, gain: SFX_SOUNDS.fire.gain });
    expect(fire.reason).toMatch(/fire under clip 3/);
  });

  it("takes given ambience over inference and merges neighbouring clips with one tag", () => {
    const sfx = autoPlaceSfx(reel(), { ambience: { a: "water", b: "water", c: null } });
    const water = sfx.filter((clip) => clip.sound === "water");
    expect(water).toHaveLength(1);
    expect(water[0]).toMatchObject({ atMs: 0, durationMs: 4000 });
    expect(sfx.some((clip) => clip.sound === "fire")).toBe(false);
  });

  it("ends the riser on the drop when the drop is inside the reel, and cuts it short near the start", () => {
    const sfx = autoPlaceSfx(reel(), { dropMs: 8000 });
    expect(sfxEndMs(sfx.find((clip) => clip.sound === "riser")!)).toBe(8000);
    const early = autoPlaceSfx(reel(), { revealMs: 2000 });
    const riser = early.find((clip) => clip.sound === "riser")!;
    expect(riser).toMatchObject({ atMs: 0, offsetMs: 1000 });
    expect(sfxEndMs(riser)).toBe(2000);
  });

  it("keeps hand-placed sounds, replaces its own, and is the same twice", () => {
    const base = withSfx(reel(), [{ id: "mine", sound: "wind", atMs: 500, durationMs: 1000 }]);
    const once = autoPlaceSfx(base);
    expect(once.filter((clip) => clip.id === "mine")).toHaveLength(1);
    const twice = autoPlaceSfx(withSfx(base, once));
    expect(twice).toEqual(once);
  });

  it("whooshes on quick cuts only when asked", () => {
    const quick = parseTimeline({ ...emptyTimeline(), clips: [clip("a", 1000), clip("b", 1000), clip("c", 1000), clip("d", 3000)] });
    expect(autoPlaceSfx(quick).filter((clip) => clip.sound.startsWith("whoosh"))).toHaveLength(0);
    const whooshes = autoPlaceSfx(quick, { whooshHardCuts: true }).filter((clip) => clip.sound.startsWith("whoosh"));
    expect(whooshes.map((clip) => clip.atMs + 300)).toEqual([1000, 2000]);
    // Three whooshes rotate.
    expect(new Set(whooshes.map((clip) => clip.sound)).size).toBe(2);
  });

  it("places nothing on a reel of one clip without a tag", () => {
    expect(autoPlaceSfx(parseTimeline({ ...emptyTimeline(), clips: [clip("a", 3000)] }))).toEqual([]);
  });
});

describe("sfx levels and housekeeping", () => {
  it("fades in and out and is silent outside its window", () => {
    const fire = { id: "f", sound: "fire" as const, atMs: 1000, durationMs: 2000, gain: 0.5, fadeInMs: 400, fadeOutMs: 400 };
    expect(sfxGainAt(fire, 999)).toBe(0);
    expect(sfxGainAt(fire, 1200)).toBeCloseTo(0.25);
    expect(sfxGainAt(fire, 2000)).toBe(0.5);
    expect(sfxGainAt(fire, 2900)).toBeCloseTo(0.125);
    expect(sfxGainAt(fire, 3000)).toBe(0);
    // A whoosh without a duration plays its own length at its usual level.
    const whoosh = { id: "w", sound: "whoosh-1" as const, atMs: 0 };
    expect(sfxEndMs(whoosh)).toBe(700);
    expect(sfxGainAt(whoosh, 100)).toBe(SFX_SOUNDS["whoosh-1"].gain);
    expect(sfxEndMs({ ...whoosh, offsetMs: 200 })).toBe(500);
  });

  it("lists the sounds used and trims sounds that fell off the reel", () => {
    const timeline = withSfx(reel(), [{ id: "a", sound: "wind", atMs: 0 }, { id: "b", sound: "whoosh-2", atMs: 9000 }, { id: "c", sound: "whoosh-2", atMs: 20_000 }]);
    expect(sfxSoundsUsed(timeline)).toEqual(["whoosh-2", "wind"]);
    expect(trimSfxToReel(timeline).sfx!.map((clip) => clip.id)).toEqual(["a", "b"]);
    expect(withSfx(timeline, []).sfx).toBeUndefined();
  });

  it("maps tags to the bundled sounds and reads them from words", () => {
    expect(ambienceFor("snow").sound).toBe("wind");
    expect(ambienceFor("city").sound).toBe("room-tone");
    expect(inferAmbienceTag(clip("x", 1000, { room: "master bath" }), [])).toBe("water");
    expect(inferAmbienceTag(clip("x", 1000), [{ text: "Snowed in for the weekend" }])).toBe("snow");
    expect(inferAmbienceTag(clip("x", 1000), [])).toBeNull();
  });

  it("moves the drop into reel time", () => {
    const music = { assetId: "s", sourceStartMs: 2000, volume: 0.8, bpm: 120, beatOffsetMs: 0 };
    expect(reelDropMs(6000, music, 10_000)).toBe(4000);
    expect(reelDropMs(1000, music, 10_000)).toBeNull();
    expect(reelDropMs(null, music, 10_000)).toBeNull();
  });
});

describe("the sfx commands", () => {
  it("autoSfx and setSfx land as one change each, and the result is a valid timeline", () => {
    const placed = applyCommand(reel(), { type: "autoSfx" }, { generation: 1 });
    expect(placed.rejected).toBeUndefined();
    expect(placed.changes).toEqual([{ kind: "other", key: "sfx" }]);
    expect(placed.timeline.sfx!.length).toBeGreaterThan(2);
    const cleared = applyCommand(placed.timeline, { type: "setSfx", sfx: [] }, { generation: 1 });
    expect(cleared.timeline.sfx).toBeUndefined();
    expect(applyCommand(cleared.timeline, { type: "setSfx", sfx: [] }, { generation: 1 }).changes).toEqual([]);
  });
});
