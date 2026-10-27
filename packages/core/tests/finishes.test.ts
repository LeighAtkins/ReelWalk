import { describe, expect, it } from "vitest";
import type { AiSong } from "../src/ai-edit";
import { applyCommand } from "../src/commands";
import { applyFinish, currentFinish, finishRestyles, heldByFinish, pickFinishSong } from "../src/finishes";
import { parseTimeline, timelineDurationMs, timelineSchema, type Timeline } from "../src/timeline";

// Two finishes (ADR 0064): music mood, type, pace and look set together, as one command,
// without undoing the studio's own work.

const durations = { v1: 20000, v2: 20000, talk: 20000, "ai-take": 6000, song: 60000, piano: 90000 };

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 8000 },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
      { id: "c", assetId: "p", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, motion: "zoom-in" },
    ],
    texts: [
      { id: "hook", text: "Just listed", startMs: 0, endMs: 2000, style: "headline", size: 1.2 },
      { id: "kitchen", text: "Kitchen", startMs: 7000, endMs: 9000, style: "box", size: 0.6 },
      { id: "hook-word-1", text: "THIS", startMs: 0, endMs: 1500, style: "headline", behind: true },
    ],
    music: { assetId: "song", sourceStartMs: 0, volume: 0.6, bpm: 120, beatOffsetMs: 0, autoPicked: true },
    hook: { kind: "alert", title: "Price drop", font: "sans" },
  });
}

const text = (timeline: Timeline, id: string) => timeline.texts.find((item) => item.id === id)!;

describe("applyFinish", () => {
  it("premium: golden grade with soft lens, serif fading type, slower shots, serif hook; push-ins stay", () => {
    const after = applyFinish(reel(), "premium", { sourceDurationsMs: durations });
    expect(timelineSchema.safeParse(after).success).toBe(true);
    expect(after.clips.every((clip) => clip.filter === "golden" && clip.lensSoftness === 0.28)).toBe(true);
    expect(after.clips[2].motion).toBe("zoom-in");
    expect(text(after, "hook")).toMatchObject({ style: "elegant", font: "serif", animation: "fade", shadow: "soft" });
    expect(text(after, "hook-word-1")).toMatchObject({ style: "headline" });
    expect(after.hook?.font).toBe("serif");
    const pop = applyFinish(reel(), "pop", { sourceDurationsMs: durations });
    expect(timelineDurationMs(after)).toBeGreaterThan(timelineDurationMs(pop));
    expect(currentFinish(after)).toBe("premium");
  });

  it("pop: vivid, bold sans that pops in, and clears the soft lens", () => {
    const after = applyFinish(applyFinish(reel(), "premium", { sourceDurationsMs: durations }), "pop", { sourceDurationsMs: durations });
    expect(after.clips.every((clip) => clip.filter === "vivid" && clip.lensSoftness === undefined)).toBe(true);
    expect(text(after, "kitchen")).toMatchObject({ style: "headline", font: "sans", animation: "pop" });
    expect(after.hook?.font).toBe("sans");
    expect(currentFinish(after)).toBe("pop");
    expect(currentFinish(reel())).toBeNull();
  });

  it("never makes a title smaller than the studio set it", () => {
    const big = parseTimeline({ ...reel(), texts: [{ id: "t", text: "Big", startMs: 0, endMs: 2000, style: "headline", size: 2 }, { id: "s", text: "small", startMs: 0, endMs: 2000, size: 0.6 }] });
    const premium = applyFinish(big, "premium", { sourceDurationsMs: durations });
    expect(text(premium, "t").size).toBe(2);
    expect(text(premium, "s").size).toBe(0.6);
    // Pop brings a small caption up to read; it never brings one down.
    expect(text(applyFinish(big, "pop", { sourceDurationsMs: durations }), "s").size).toBe(1);
  });

  it("leaves placed and crafted titles exactly as they are", () => {
    const crafted = parseTimeline({
      ...reel(),
      texts: [
        { id: "pinned", text: "Pool", startMs: 0, endMs: 2000, pin: { assetId: "v1", fromMs: 2000, toMs: 4000 }, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.1, y: 0 }] },
        { id: "wall", text: "Wall", startMs: 0, endMs: 2000, surface: [0.1, 0.1, 0.5, 0.1, 0.5, 0.3, 0.1, 0.3] },
        { id: "painted", text: "Paint", startMs: 0, endMs: 2000, blend: "surface" },
        { id: "deep", text: "3D", startMs: 0, endMs: 2000, depth: "extruded" },
        { id: "tag", text: "SOLD", startMs: 0, endMs: 2000, style: "tag", size: 0.6 },
      ],
    });
    for (const item of crafted.texts) expect(finishRestyles(item), item.id).toBe(false);
    expect(finishRestyles({ ...crafted.texts[4], style: "plain", callout: { at: 1 } } as never)).toBe(false);
    expect(finishRestyles({ ...crafted.texts[4], style: "plain", kinetic: "words" } as never)).toBe(false);
    expect(finishRestyles({ ...crafted.texts[4], style: "plain", shine: true } as never)).toBe(false);
    // An inverted title (ADR 0091) keeps its tint.
    expect(finishRestyles({ ...crafted.texts[4], style: "plain", blend: "invert" } as never)).toBe(false);
    const after = applyFinish(crafted, "premium", { sourceDurationsMs: durations });
    for (const id of ["wall", "painted", "deep", "tag"]) {
      const { startMs, endMs, ...rest } = text(after, id);
      const { startMs: s0, endMs: e0, ...before } = text(crafted, id);
      expect(rest, id).toEqual(before);
      void startMs; void endMs; void s0; void e0;
    }
    expect(text(after, "pinned").pin).toEqual(text(crafted, "pinned").pin);
  });

  it("holds clips with speech and AI takes: same windows, same order", () => {
    const talky = parseTimeline({
      ...reel(),
      clips: [
        { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 8000 },
        { id: "t", assetId: "talk", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 7500 },
        { id: "script-ai-take", assetId: "ai-take", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 6000 },
        { id: "c", assetId: "p", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
      ],
    });
    expect(heldByFinish(talky.clips[1], ["talk"])).toBe(true);
    expect(heldByFinish(talky.clips[1], [])).toBe(false);
    expect(heldByFinish(talky.clips[2])).toBe(true);
    expect(heldByFinish({ ...talky.clips[1], volume: 0 }, ["talk"])).toBe(false);
    // With a tempo the pacing engine cuts (ADR 0059); without one, every shot at the finish's length. Held clips stay either way.
    const noTempo = parseTimeline({ ...talky, music: null });
    for (const id of ["pop", "premium"] as const) {
      for (const reelIn of [talky, noTempo]) {
        const after = applyFinish(reelIn, id, { sourceDurationsMs: durations, speechAssetIds: ["talk"] });
        const order = after.clips.map((clip) => clip.id);
        expect(order.indexOf("t")).toBeLessThan(order.indexOf("script-ai-take"));
        expect(after.clips.find((clip) => clip.id === "t")).toMatchObject({ sourceStartMs: 1000, sourceEndMs: 7500 });
        expect(after.clips.find((clip) => clip.id === "script-ai-take")).toMatchObject({ sourceStartMs: 0, sourceEndMs: 6000 });
      }
      expect(applyFinish(noTempo, id, { sourceDurationsMs: durations, speechAssetIds: ["talk"] }).clips[3].sourceEndMs).toBe(id === "pop" ? 2000 : 3500);
    }
  });

  it("paces through the pacing engine at the finish's energy, with On the beat as the song has it", () => {
    const pop = applyFinish(reel(), "pop", { sourceDurationsMs: durations });
    const premium = applyFinish(reel(), "premium", { sourceDurationsMs: durations });
    expect(pop.music?.energy).toBe(0.85);
    expect(premium.music?.energy).toBe(0.3);
    expect(pop.music?.pace).toBeDefined();
    // A song a finish picks is set like any picked song: On the beat on unless the reel had it off.
    const picked = applyFinish(reel(), "premium", { music: { assetId: "piano", sourceStartMs: 0, bpm: 70, beatOffsetMs: 0 }, sourceDurationsMs: durations });
    expect(picked.music?.onBeat).toBe(true);
  });

  it("switches the song when given one, marking it as its own pick, and keeps it otherwise", () => {
    expect(applyFinish(reel(), "premium").music?.assetId).toBe("song");
    const after = applyFinish(reel(), "premium", { music: { assetId: "piano", sourceStartMs: 0, bpm: 70, beatOffsetMs: 0 }, sourceDurationsMs: durations });
    expect(after.music).toMatchObject({ assetId: "piano", volume: 0.6, bpm: 70, autoPicked: true });
  });

  it("is one command, so one undo step, and leaves an empty reel alone", () => {
    const result = applyCommand(reel(), { type: "applyFinish", finish: "pop", speechAssetIds: [] }, { generation: 0, sourceDurationsMs: durations });
    expect(result.rejected).toBeUndefined();
    expect(result.changes.length).toBeGreaterThan(0);
    const empty = parseTimeline({ version: 1, clips: [], texts: [], music: null });
    expect(applyFinish(empty, "premium")).toBe(empty);
  });
});

describe("pickFinishSong", () => {
  const songs: AiSong[] = [
    { id: "song", title: "Funkorama", bpm: 120, mood: "funky and energetic; playful" },
    { id: "piano", title: "Inspired", bpm: 70, mood: "gentle piano that slowly builds; calm, hopeful" },
    { id: "nobeat", title: "Wallpaper", bpm: null, mood: "soft and ambient; calm, stays in the background" },
  ];

  it("never replaces a song the studio picked", () => {
    expect(pickFinishSong(songs, "premium", { assetId: "song" })).toBeNull();
    expect(pickFinishSong(songs, "premium", { assetId: "song", autoPicked: false })).toBeNull();
  });

  it("keeps an automatic pick that already fits the mood", () => {
    expect(pickFinishSong(songs, "pop", { assetId: "song", autoPicked: true })).toBeNull();
  });

  it("replaces an automatic pick, or none, with a fitting song (one with a known tempo first)", () => {
    expect(pickFinishSong(songs, "premium", { assetId: "song", autoPicked: true })?.id).toBe("piano");
    expect(pickFinishSong([songs[2], songs[1]], "premium")?.id).toBe("piano");
  });

  it("returns null (keep the song) when nothing fits", () => {
    expect(pickFinishSong([songs[0]], "premium", { assetId: "song", autoPicked: true })).toBeNull();
  });

  it("matches an Instagram sound by its audio id", () => {
    const track = { id: "ig1", title: "Piano", artist: null, type: "LICENSED" } as unknown as NonNullable<AiSong["instagram"]>;
    const ig: AiSong[] = [{ id: "x", title: "Piano", bpm: null, mood: "piano, calm and elegant", instagram: track }];
    expect(pickFinishSong(ig, "premium", { assetId: "x", instagramAudioId: "ig1", autoPicked: true })).toBeNull();
    expect(pickFinishSong(ig, "premium")?.instagram?.id).toBe("ig1");
  });
});
