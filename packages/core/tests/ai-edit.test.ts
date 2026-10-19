import { describe, expect, it } from "vitest";
import { AI_BRIEFS, AI_EDIT_PLAN_JSON_SCHEMA, aiEditPlanSchema, songMood, applyAiEditPlan, cutsOnBeat, describeReel, fakeAiEditPlan, type AiAsset, type AiEditOp, type AiSong } from "../src/ai-edit";
import { clipDurationMs, parseTimeline, type Timeline } from "../src/timeline";

const assets: Record<string, AiAsset> = {
  k: { id: "k", kind: "VIDEO", title: "kitchen pan", durationMs: 12000, isPano: false, bpm: null, beatOffsetMs: null },
  l: { id: "l", kind: "IMAGE", title: "lounge", durationMs: null, isPano: false, bpm: null, beatOffsetMs: null },
  s1: { id: "s1", kind: "AUDIO", title: "Carefree", durationMs: 120000, isPano: false, bpm: 96, beatOffsetMs: 120 },
  s2: { id: "s2", kind: "AUDIO", title: "Fretless", durationMs: 150000, isPano: false, bpm: 100, beatOffsetMs: 0 },
};
const songs: AiSong[] = [
  { id: "s1", title: "Carefree", bpm: 96, mood: "light, bouncy ukulele; cheerful" },
  { id: "s2", title: "Fretless", bpm: 100, mood: "slow and smooth; late-night, classy" },
];

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "k", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, room: "kitchen" },
      { id: "c2", assetId: "l", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, motion: "zoom-in", room: "living room" },
    ],
    texts: [{ id: "t1", text: "Just listed", startMs: 0, endMs: 3000, style: "headline" }],
    music: { assetId: "s1", sourceStartMs: 0, volume: 0.8, bpm: 96, beatOffsetMs: 120 },
    plan: null,
    details: null,
  });
}

const blank: Omit<AiEditOp, "op"> = {
  clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
  volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
  assetId: null, order: null, pieces: null, atClip: null, animation: null, zoom: null, corner: null, yaw: null, sweep: null,
};
const op = (fields: Partial<AiEditOp> & { op: AiEditOp["op"] }): AiEditOp => ({ ...blank, ...fields });

describe("describeReel", () => {
  it("numbers clips and texts, names rooms and lists the songs with moods", () => {
    const text = describeReel({ title: "City apartment", timeline: reel(), assets, songs });
    expect(text).toContain('Reel "City apartment", 7.0 s long, 2 clips');
    expect(text).toContain("1. video, kitchen, plays 4.0 s at 0.0 s; source 0.0 s–4.0 s of 12.0 s, speed 1x, sound 100%");
    expect(text).toContain("2. photo, living room, plays 3.0 s at 4.0 s; look none; motion zoom-in; transition in cut");
    expect(text).toContain('1. "Just listed", style headline');
    expect(text).toContain('Music: "Carefree" (songId s1), 96 bpm, volume 80%');
    expect(text).toContain('- s2: "Fretless", 100 bpm, slow and smooth; late-night, classy');
  });
});

describe("applyAiEditPlan", () => {
  it("lengthens a video clip by output length, within its source", () => {
    const { timeline, applied, skipped } = applyAiEditPlan(reel(), { ops: [op({ op: "trim", clip: 1, lengthMs: 6000 })], note: "" }, { assets, songs });
    expect(clipDurationMs(timeline.clips[0])).toBe(6000);
    expect(applied).toEqual(["clip 1 (kitchen) now plays 6.0 s"]);
    expect(skipped).toEqual([]);
  });

  it("cannot play more of a video than its source has", () => {
    const { timeline } = applyAiEditPlan(reel(), { ops: [op({ op: "trim", clip: 1, lengthMs: 30000 })], note: "" }, { assets, songs });
    expect(timeline.clips[0].sourceEndMs).toBe(12000);
  });

  it("applies a look to every clip with clip 0, and a speed only to videos", () => {
    const plan = { ops: [op({ op: "look", clip: 0, filter: "warm" }), op({ op: "speed", clip: 0, speed: 2 })], note: "" };
    const { timeline, applied } = applyAiEditPlan(reel(), plan, { assets, songs });
    expect(timeline.clips.map((clip) => clip.filter)).toEqual(["warm", "warm"]);
    expect(timeline.clips[0].speed).toBe(2);
    expect(timeline.clips[1].speed).toBe(1);
    expect(applied).toEqual(["every clip: look warm", "clip 1 (kitchen): speed 2x"]);
  });

  it("swaps the music for a listed song and refuses one that is not listed", () => {
    const plan = { ops: [op({ op: "music", songId: "s2" }), op({ op: "music", songId: "nope" })], note: "" };
    const { timeline, applied, skipped } = applyAiEditPlan(reel(), plan, { assets, songs });
    expect(timeline.music).toMatchObject({ assetId: "s2", bpm: 100, beatOffsetMs: 0, volume: 0.8 });
    expect(applied).toEqual(['music is now "Fretless"']);
    expect(skipped).toEqual(["music: no song nope in the list"]);
  });

  it("resolves numbers against the reel as described, even after a removal", () => {
    const plan = { ops: [op({ op: "remove", clip: 1 }), op({ op: "look", clip: 2, filter: "mono" })], note: "" };
    const { timeline, applied } = applyAiEditPlan(reel(), plan, { assets, songs });
    expect(timeline.clips).toHaveLength(1);
    expect(timeline.clips[0]).toMatchObject({ id: "c2", filter: "mono" });
    expect(applied).toEqual(["clip 1 (kitchen) removed", "clip 1 (living room): look mono"]);
  });

  it("adds, edits and removes text, keeping it inside the reel", () => {
    const plan = {
      ops: [
        op({ op: "addText", content: "Open Saturday", style: "elegant", y: 0.8, startMs: 4000 }),
        op({ op: "editText", text: 1, content: "Just listed in Austin" }),
        op({ op: "addText", content: "Too late", startMs: 60000 }),
      ],
      note: "",
    };
    const { timeline, applied, skipped } = applyAiEditPlan(reel(), plan, { assets, songs, newId: () => "new" });
    expect(timeline.texts.map((text) => text.text)).toEqual(["Just listed in Austin", "Open Saturday"]);
    // y 0.8 is under Instagram's buttons: the editor keeps the text inside the safe band and says so.
    expect(timeline.texts[1]).toMatchObject({ id: "new", style: "elegant", y: 0.72, startMs: 4000, endMs: 7000 });
    expect(applied).toEqual(['added text "Open Saturday"', 'text "Just listed" changed to "Just listed in Austin"', 'moved "Open Saturday" into the safe area']);
    expect(skipped).toEqual(['addText: "Too late" would start after the reel ends']);
  });

  it("fills in and removes the details card", () => {
    const details = { price: "$1,250,000", beds: "3", baths: null, area: null, address: null, contact: null, placement: null };
    const first = applyAiEditPlan(reel(), { ops: [op({ op: "details", details })], note: "" }, { assets, songs });
    expect(first.timeline.details).toMatchObject({ price: "$1,250,000", beds: "3", placement: "end" });
    const second = applyAiEditPlan(first.timeline, { ops: [op({ op: "details", details: null })], note: "" }, { assets, songs });
    expect(second.timeline.details).toBeNull();
  });

  it("skips what it cannot do and explains", () => {
    const plan = {
      ops: [op({ op: "trim", clip: 9, lengthMs: 1000 }), op({ op: "transition", clip: 1, transition: "fade" }), op({ op: "roomLabels", on: null })],
      note: "",
    };
    const { timeline, applied, skipped } = applyAiEditPlan(reel(), plan, { assets, songs });
    expect(timeline).toEqual(reel());
    expect(applied).toEqual([]);
    expect(skipped).toEqual(["trim: there is no clip 9", "transition: the first clip has nothing to transition from", "roomLabels: say on or off"]);
  });

  it("turns room labels on for clips that know their room", () => {
    const { timeline } = applyAiEditPlan(reel(), { ops: [op({ op: "roomLabels", on: true })], note: "" }, { assets, songs });
    expect(timeline.texts.filter((text) => text.id.startsWith("room-")).map((text) => text.text)).toEqual(["Kitchen", "Living room"]);
  });
});

describe("keeping the rest of the reel in step", () => {
  it("text over a clip moves with the clip when an earlier one is removed or lengthened", () => {
    const base = reel();
    // "Lounge" sits over clip 2 (4.0–7.0 s), one second in.
    // On its own line (y 0.6), so the test is about following the clip, not two texts sharing a line.
    const withText = { ...base, texts: [...base.texts, { ...base.texts[0], id: "t2", text: "Lounge", startMs: 5000, endMs: 7000, y: 0.6 }] };
    const longer = applyAiEditPlan(withText, { ops: [op({ op: "trim", clip: 1, lengthMs: 6000 })], note: "" }, { assets, songs });
    expect(longer.timeline.texts.find((text) => text.id === "t2")).toMatchObject({ startMs: 7000, endMs: 9000 });
    const removed = applyAiEditPlan(withText, { ops: [op({ op: "remove", clip: 1 })], note: "" }, { assets, songs });
    // The title that opened the reel still opens it, over the clip now first.
    expect(removed.timeline.texts.find((text) => text.id === "t1")).toMatchObject({ startMs: 0, endMs: 3000 });
    expect(removed.timeline.texts.find((text) => text.id === "t2")).toMatchObject({ startMs: 1000, endMs: 3000 });
  });

  it("cuts that were on the beat go back on it after a trim, and room labels are redrawn", () => {
    // 96 bpm = 625 ms a beat; a 4000 ms cut sits on beat 6.4, so first put it on the beat.
    const base = applyAiEditPlan(reel(), { ops: [op({ op: "roomLabels", on: true }), op({ op: "snapToBeat" })], note: "" }, { assets, songs }).timeline;
    expect(cutsOnBeat(base)).toBe(true);
    const { timeline, applied } = applyAiEditPlan(base, { ops: [op({ op: "trim", clip: 1, lengthMs: 5400 })], note: "" }, { assets, songs });
    expect(cutsOnBeat(timeline)).toBe(true);
    expect(applied).toContain("cuts kept on the beat");
    const label = timeline.texts.find((text) => text.id === "room-c2")!;
    expect(label.startMs).toBeGreaterThanOrEqual(clipDurationMs(timeline.clips[0]));
  });

  it("leaves texts alone when nothing structural changed", () => {
    const { timeline } = applyAiEditPlan(reel(), { ops: [op({ op: "look", clip: 0, filter: "mono" })], note: "" }, { assets, songs });
    expect(timeline.texts).toEqual(reel().texts);
  });
});

describe("cutting from unused media", () => {
  const unused: AiAsset[] = [
    { id: "d", kind: "VIDEO", title: "drone over the house", durationMs: 9000, isPano: false, bpm: null, beatOffsetMs: null, room: null },
    { id: "p", kind: "IMAGE", title: "pool (360)", durationMs: null, isPano: true, bpm: null, beatOffsetMs: null, room: "pool" },
  ];

  it("lists unused media to the model", () => {
    const text = describeReel({ title: "New", timeline: reel(), assets, songs, unused });
    expect(text).toContain('- d: video, 9.0 s, "drone over the house"');
    expect(text).toContain('- p: 360 photo, "pool (360)", pool');
  });

  it("adds shots, orders them by number (new ones counted after the shown ones) and trims a new clip", () => {
    let n = 0;
    const plan = {
      ops: [op({ op: "add", assetId: "d", toPosition: 1 }), op({ op: "add", assetId: "p" }), op({ op: "order", order: [3, 1, 4, 2] }), op({ op: "trim", clip: 3, lengthMs: 3000 })],
      note: "",
      questions: [],
    };
    const { timeline, applied, skipped } = applyAiEditPlan(reel(), plan, { assets, songs, unused, newId: () => `n${++n}` });
    expect(timeline.clips.map((clip) => clip.assetId)).toEqual(["d", "k", "p", "l"]);
    expect(clipDurationMs(timeline.clips[0])).toBe(3000);
    expect(timeline.clips[2]).toMatchObject({ kind: "IMAGE", pano: { yawStart: -45 }, room: "pool", sourceEndMs: 5000 });
    expect(skipped).toEqual([]);
    expect(applied[0]).toBe('added "drone over the house" as clip 1');
  });

  it("refuses media that is not in the unused list", () => {
    const { skipped } = applyAiEditPlan(reel(), { ops: [op({ op: "add", assetId: "zzz" })], note: "", questions: [] }, { assets, songs, unused });
    expect(skipped).toEqual(["add: no unused media zzz"]);
  });

  it("carries questions through the schema with no operations", () => {
    const parsed = aiEditPlanSchema.parse({ ops: [], note: "Tell me the open-house time and I will cut it.", questions: ["What day and time is the open house?"] });
    expect(parsed.questions).toHaveLength(1);
  });
});

describe("whole-reel cuts", () => {
  it("names a clip's room so room labels can go on", () => {
    const base = parseTimeline({ ...reel(), clips: reel().clips.map((clip) => ({ ...clip, room: null })), texts: [] });
    const plan = { ops: [op({ op: "room", clip: 1, content: "Kitchen" }), op({ op: "roomLabels", on: true })], note: "", questions: [] };
    const { timeline, applied, skipped } = applyAiEditPlan(base, plan, { assets, songs });
    expect(timeline.clips[0].room).toBe("kitchen");
    expect(timeline.texts.map((text) => text.text)).toEqual(["Kitchen"]);
    expect(applied[0]).toBe("clip 1 (kitchen pan) is the kitchen");
    expect(skipped).toEqual([]);
  });

  it("a hook added with the plan ends on the cut after the beat moved it", () => {
    // 96 bpm: a 4.0 s first clip snaps to 4.375 s; the hook asked to end at 4.0 s follows.
    const plan = { ops: [op({ op: "addText", content: "Open Sunday", style: "box", startMs: 0, endMs: 4000, y: 0.42 }), op({ op: "snapToBeat" })], note: "", questions: [] };
    const { timeline } = applyAiEditPlan(reel(), plan, { assets, songs, newId: () => "hook" });
    const cut = clipDurationMs(timeline.clips[0]);
    expect(cut).not.toBe(4000);
    expect(timeline.texts.find((text) => text.id === "hook")!.endMs).toBe(cut);
  });

  it("the briefs ask for shots fast enough to read as a reel", () => {
    expect(AI_BRIEFS.find((brief) => brief.id === "just-listed")!.text).toContain("1.5 to 2.5 seconds");
  });
});

describe("song moods", () => {
  it("the bundled songs have their own; the studio's are read from name and tempo", () => {
    expect(songMood("Fretless")).toContain("classy");
    expect(songMood("Staring at the Night Sky", 118)).toBe("calm, soft");
    expect(songMood("Possible Dreams", 174)).toBe("calm, soft; fast tempo");
    expect(songMood("Track 7", 120)).toBeNull();
  });

  it("the studio's own songs are marked for the model", () => {
    const text = describeReel({ title: "x", timeline: reel(), assets, songs: [{ id: "o", title: "Charlotte", bpm: 100, mood: "calm, soft", own: true }] });
    expect(text).toContain('- o: "Charlotte", 100 bpm, calm, soft, the studio\'s own');
  });
});

describe("the plan schema", () => {
  it("accepts what the model sends and rejects values outside the vocabulary", () => {
    expect(aiEditPlanSchema.safeParse({ ops: [op({ op: "look", clip: 0, filter: "warm" })], note: "Warmer." }).success).toBe(true);
    expect(aiEditPlanSchema.safeParse({ ops: [{ ...op({ op: "look", clip: 0 }), filter: "sepia" }], note: "" }).success).toBe(false);
    expect(aiEditPlanSchema.safeParse({ ops: [{ op: "explode" }], note: "" }).success).toBe(false);
  });

  it("the JSON schema for the API names every field the zod schema has", () => {
    const item = AI_EDIT_PLAN_JSON_SCHEMA.properties.ops.items;
    expect([...item.required].sort()).toEqual(Object.keys(blank).concat("op").sort());
    expect(Object.keys(item.properties).sort()).toEqual([...item.required].sort());
  });
});

describe("fakeAiEditPlan", () => {
  it("handles a few plain requests end to end", () => {
    const plan = fakeAiEditPlan("make the kitchen longer, warmer, and calmer music", reel(), songs);
    const { timeline, applied } = applyAiEditPlan(reel(), plan, { assets, songs });
    expect(clipDurationMs(timeline.clips[0])).toBe(6000);
    expect(timeline.clips[1].filter).toBe("warm");
    expect(timeline.music?.assetId).toBe("s2");
    expect(applied).toHaveLength(3);
    expect(plan.note).toContain("Fretless");
  });

  it("says so when it cannot tell what to change", () => {
    expect(fakeAiEditPlan("hello", reel(), songs)).toMatchObject({ ops: [] });
  });
});
