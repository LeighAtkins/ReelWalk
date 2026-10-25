import { describe, expect, it } from "vitest";
import { applyAiEditPlan, type AiAsset, type AiEditOp } from "../src/ai-edit";
import { pinnedProgress, PINNED_ELSEWHERE } from "../src/cinematic";
import { applyCommand, type Command, type CommandContext } from "../src/commands";
import { retime } from "../src/review";
import { textAttachment } from "../src/text-timing";
import { addRoomLabels, clipStartsMs, MAX_TEXTS, parseTimeline, timelineDurationMs, timelineSchema, type Timeline } from "../src/timeline";

// One cut change, whichever button makes it, moves the titles the same way (ADR 0048, slip 28).

const durations = { v1: 20000, v2: 20000, song: 60000 };
const ctx: CommandContext = { generation: 0, sourceDurationsMs: durations };

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 8000 },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
      { id: "c", assetId: "p", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
    ],
    texts: [
      // Inside clip a (0–6 s): attached to a.
      { id: "title", text: "Ocean views", startMs: 3500, endMs: 5000, style: "elegant" },
      // Inside clip b (6–10 s): attached to b.
      { id: "kitchen", text: "Kitchen", startMs: 7000, endMs: 9000, style: "elegant", y: 0.6 },
      // Across the a|b and b|c cuts: reel-relative.
      { id: "caption", text: "Just listed", startMs: 4000, endMs: 11000, style: "tag", y: 0.3, size: 0.6 },
    ],
    music: null,
  });
}

const assets: Record<string, AiAsset> = {
  v1: { id: "v1", kind: "VIDEO", title: "walk", durationMs: 20000, isPano: false, bpm: null, beatOffsetMs: null },
  v2: { id: "v2", kind: "VIDEO", title: "kitchen", durationMs: 20000, isPano: false, bpm: null, beatOffsetMs: null },
  p: { id: "p", kind: "IMAGE", title: "pool", durationMs: null, isPano: false, bpm: null, beatOffsetMs: null },
};
const blank: Omit<AiEditOp, "op"> = {
  clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
  volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
  assetId: null, order: null, pieces: null, atClip: null, animation: null, zoom: null, corner: null, yaw: null, sweep: null,
};
const op = (fields: Partial<AiEditOp> & { op: AiEditOp["op"] }): AiEditOp => ({ ...blank, ...fields });
const times = (timeline: Timeline) => Object.fromEntries(timeline.texts.map((text) => [text.id, [text.startMs, text.endMs]]));
const apply = (timeline: Timeline, command: Command) => applyCommand(timeline, command, ctx);

describe("which texts follow a clip", () => {
  it("a text inside one clip is attached to it; one across a cut is reel-relative", () => {
    const timeline = reel();
    const of = (id: string) => textAttachment(timeline, timeline.texts.find((text) => text.id === id)!);
    expect(of("title")).toEqual({ kind: "clip", clipId: "a" });
    expect(of("kitchen")).toEqual({ kind: "clip", clipId: "b" });
    expect(of("caption")).toEqual({ kind: "reel" });
  });

  it("a pinned text is attached to the clip it was tracked on even when it runs past the cut", () => {
    const timeline = parseTimeline({ ...reel(), texts: [{ id: "pinned", text: "Pool", startMs: 5000, endMs: 8000, pin: { assetId: "v1", fromMs: 7000, toMs: 10000 } }] });
    expect(textAttachment(timeline, timeline.texts[0])).toEqual({ kind: "clip", clipId: "a" });
  });

  it("room labels are managed, not attached", () => {
    const timeline = parseTimeline({ ...reel(), texts: [{ id: "room-a", text: "Kitchen", startMs: 200, endMs: 6000 }] });
    expect(textAttachment(timeline, timeline.texts[0])).toEqual({ kind: "managed" });
  });
});

describe("the same cut change through trim, an AI proposal and the review", () => {
  it("moves the titles identically", () => {
    // A title that fits inside the trimmed clip (source 5.5–6.5 s): the review never cuts a title at its clip's end,
    // trims do when the title would spill over, so the comparison is about where titles go, not that cut.
    const base = parseTimeline({ ...reel(), texts: reel().texts.map((text) => (text.id === "title" ? { ...text, endMs: 4500 } : text)) });
    // retime(…, 3000) keeps the middle 3 s of clip a (source 2–8 s): 3.5–6.5 s. Clip b is 4 s → its middle 3 s, 0.5–3.5 s. Photo c → 3 s.
    const review = retime(base, 3000, durations);
    expect(review.clips.map((clip) => [clip.sourceStartMs, clip.sourceEndMs])).toEqual([
      [3500, 6500],
      [500, 3500],
      [0, 3000],
    ]);

    // The same windows by hand, one trim each.
    let manual = base;
    manual = apply(manual, { type: "trimClip", clipId: "a", window: { sourceStartMs: 3500, sourceEndMs: 6500 } }).timeline;
    manual = apply(manual, { type: "trimClip", clipId: "b", window: { sourceStartMs: 500, sourceEndMs: 3500 } }).timeline;

    // The same windows asked of the AI, then applied as a proposal.
    const plan = applyAiEditPlan(base, {
      ops: [op({ op: "trim", clip: 1, startMs: 3500, endMs: 6500 }), op({ op: "trim", clip: 2, startMs: 500, endMs: 3500 })],
      note: "",
    }, { assets, songs: [], newId: () => "n" });
    const proposal = apply(base, { type: "applyProposal", baseGeneration: 0, proposal: plan.timeline });

    expect(times(manual)).toEqual(times(review));
    expect(times(proposal.timeline)).toEqual(times(review));
    // The title kept its frame (source 5.5 s → 2 s into the trimmed clip a); the caption kept its seconds.
    expect(times(review).title).toEqual([2000, 3000]);
    expect(times(review).caption).toEqual([4000, 9000]);
  });
});

describe("a trim handle dragged in and back out", () => {
  it("brings a squeezed title back when every step is anchored to the gesture's start", () => {
    const start = reel();
    const step = (timeline: Timeline, sourceStartMs: number) =>
      applyCommand(timeline, { type: "trimClip", clipId: "a", window: { sourceStartMs, sourceEndMs: 8000 } }, { ...ctx, gestureBase: start }).timeline;
    // The title shows source 5.5–7 s of clip a; dragging the start to 6 s cuts into it, back to 2 s restores it.
    const squeezed = step(start, 6000);
    // It shows from the clip's first frame, for no less than 1.2 s (never the old 100 ms sliver).
    expect(times(squeezed).title).toEqual([0, 1200]);
    expect(times(step(squeezed, 2000)).title).toEqual(times(start).title);
  });
});

describe("moving clips", () => {
  it("an attached text follows its clip; a reel-relative caption stays", () => {
    const { timeline, changes } = apply(reel(), { type: "moveClip", clipId: "b", toIndex: 0 });
    expect(timeline.clips.map((clip) => clip.id)).toEqual(["b", "a", "c"]);
    // Kitchen sat 1 s into b; b now starts at 0.
    expect(times(timeline).kitchen).toEqual([1000, 3000]);
    // The title sat 3.5 s into a; a now starts at 4 s.
    expect(times(timeline).title).toEqual([7500, 9000]);
    expect(times(timeline).caption).toEqual([4000, 11000]);
    expect(changes).toEqual(expect.arrayContaining([{ kind: "clip", id: "b" }, { kind: "text", id: "kitchen" }]));
    expect(changes).not.toContainEqual({ kind: "text", id: "caption" });
  });

  it("two uses of one video keep their own titles", () => {
    const twice = parseTimeline({
      ...reel(),
      clips: [
        { id: "first", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
        { id: "second", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
      ],
      texts: [{ id: "t", text: "Second use", startMs: 5000, endMs: 6000 }],
    });
    const { timeline } = apply(twice, { type: "moveClip", clipId: "second", toIndex: 0 });
    // Attached to the clip instance "second", not to the asset: it goes to 1 s into the reel.
    expect(times(timeline).t).toEqual([1000, 2000]);
  });
});

describe("music and the beat", () => {
  it("picking a song with a tempo and snapping the cuts is one command", () => {
    const { timeline, changes } = apply(reel(), { type: "setMusic", music: { assetId: "song", sourceStartMs: 0, bpm: 120, beatOffsetMs: 0 }, snap: true });
    expect(timeline.music).toMatchObject({ assetId: "song", volume: 0.8 });
    // At 120 bpm every cut is on a 500 ms grid.
    for (const start of clipStartsMs(timeline)) expect(start % 500).toBe(0);
    expect(changes).toContainEqual({ kind: "music" });
  });

  it("is one state change (one undo entry in the editor) that equals the two old steps together", () => {
    const music = { assetId: "song", sourceStartMs: 0, bpm: 97, beatOffsetMs: 120 };
    const one = apply(reel(), { type: "setMusic", music, snap: true }).timeline;
    // The old way: pick the song (one undo step), then snap (a second one).
    const picked = apply(reel(), { type: "setMusic", music }).timeline;
    const snapped = apply(picked, { type: "snapToBeat" }).timeline;
    expect(one).toEqual(snapped);
    expect(timelineDurationMs(one)).not.toBe(timelineDurationMs(reel()));
  });

  it("keeps the current song's volume when none is given", () => {
    const loud = apply(reel(), { type: "setMusic", music: { assetId: "song", sourceStartMs: 0, bpm: null, beatOffsetMs: null, volume: 0.3 } }).timeline;
    const swapped = apply(loud, { type: "setMusic", music: { assetId: "song2", sourceStartMs: 0, bpm: null, beatOffsetMs: null } }).timeline;
    expect(swapped.music?.volume).toBe(0.3);
  });
});

describe("proposals", () => {
  it("a proposal computed against an older generation is refused and changes nothing", () => {
    const current = reel();
    const proposal = { ...current, clips: current.clips.slice(1) };
    const result = applyCommand(current, { type: "applyProposal", baseGeneration: 3, proposal }, { ...ctx, generation: 4 });
    expect(result.stale).toBe(true);
    expect(result.timeline).toBe(current);
    expect(result.changes).toEqual([]);
  });

  it("a proposal against the current generation replaces the reel, with its song snapped in the same step", () => {
    const current = reel();
    const result = applyCommand(current, { type: "applyProposal", baseGeneration: 4, proposal: current, music: { assetId: "song", sourceStartMs: 0, bpm: 120, beatOffsetMs: 0, snap: true } }, { ...ctx, generation: 4 });
    expect(result.stale).toBeUndefined();
    expect(result.timeline.music?.assetId).toBe("song");
    for (const start of clipStartsMs(result.timeline)) expect(start % 500).toBe(0);
  });

  it("an invalid proposal is rejected with a reason and leaves the reel as it was", () => {
    const current = reel();
    const result = applyCommand(current, { type: "applyProposal", baseGeneration: 0, proposal: { version: 2 } }, ctx);
    expect(result.rejected).toBeTruthy();
    expect(result.timeline).toBe(current);
    expect(result.changes).toEqual([]);
  });
});

describe("titles across a split keep their length through later edits (review round 2)", () => {
  // Clip a is source 2–8 s at reel 0–6 s; the title 1–3.5 s; split at 2 s.
  const splitReel = () => {
    const start = parseTimeline({ ...reel(), texts: [{ id: "t", text: "Long title", startMs: 1000, endMs: 3500 }] });
    return apply(start, { type: "splitClip", atMs: 2000, newId: "a2" }).timeline;
  };
  const length = (timeline: Timeline) => times(timeline).t[1] - times(timeline).t[0];

  it("split keeps it whole", () => expect(times(splitReel()).t).toEqual([1000, 3500]));

  it("trimming the second piece's start", () => {
    const after = apply(splitReel(), { type: "trimClip", clipId: "a2", window: { sourceStartMs: 4200, sourceEndMs: 8000 } }).timeline;
    expect(length(after)).toBe(2500);
  });

  it("speeding up the second piece", () => {
    expect(length(apply(splitReel(), { type: "setSpeed", clipId: "a2", speed: 1.5 }).timeline)).toBe(2500);
  });

  it("duplicating the first piece", () => {
    expect(length(apply(splitReel(), { type: "duplicateClip", clipId: "a", newId: "a-copy" }).timeline)).toBe(2500);
  });

  it("the review's pace never cuts a title at its clip's end", () => {
    const paced = apply(splitReel(), { type: "retime", shotMs: 1500 }).timeline;
    expect(length(paced)).toBe(2500);
  });
});

describe("the e2e timeline spec's scenario (timeline.spec.ts)", () => {
  // exterior.jpg (3 s), walkthrough.mp4 (2 s), living-room.jpg (3 s); a text at 1.0–2.5 s over the first photo.
  const start = () =>
    parseTimeline({
      version: 1,
      clips: [
        { id: "ext", assetId: "ext", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
        { id: "walk", assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
        { id: "liv", assetId: "liv", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
      ],
      texts: [{ id: "t", text: "Drag my edges", startMs: 1000, endMs: 2500 }],
      music: null,
    });

  it("trimming the video's start leaves the photo's text alone; moving the photo after the video takes the text with it", () => {
    const trimmed = applyCommand(start(), { type: "trimClip", clipId: "walk", window: { sourceStartMs: 500, sourceEndMs: 2000 } }, { generation: 0, sourceDurationsMs: { walk: 2000 } }).timeline;
    expect(times(trimmed).t).toEqual([1000, 2500]);
    // The filmstrip drops the photo at index 1 (it passes the video's middle, not the living room's).
    const moved = apply(trimmed, { type: "moveClip", clipId: "ext", toIndex: 1 }).timeline;
    expect(moved.clips.map((clip) => clip.id)).toEqual(["walk", "ext", "liv"]);
    expect(times(moved).t).toEqual([2500, 4000]);
  });

  it("a text inside the first clip, when that clip is trimmed to end at 1.5 s, is kept inside it", () => {
    const trimmed = apply(start(), { type: "trimClip", clipId: "ext", window: { sourceStartMs: 0, sourceEndMs: 1500 } }).timeline;
    expect(times(trimmed).t).toEqual([1000, 1500]);
    expect(textAttachment(trimmed, trimmed.texts[0])).toEqual({ kind: "clip", clipId: "ext" });
  });
});

describe("more texts than a reel may have (review round 2)", () => {
  it("room labels never take the reel past the limit", () => {
    const clips = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, assetId: `p${i}`, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, room: `room ${i}` }));
    const texts = Array.from({ length: 45 }, (_, i) => ({ id: `t${i}`, text: `Text ${i}`, startMs: 0, endMs: 1000 }));
    const labelled = addRoomLabels(parseTimeline({ version: 1, clips, texts, music: null }));
    expect(labelled.texts).toHaveLength(MAX_TEXTS);
    expect(timelineSchema.safeParse(labelled).success).toBe(true);
  });

  it("a reel that was already over the limit stays editable, with a warning", () => {
    const valid = reel();
    const over = { ...valid, texts: Array.from({ length: 55 }, (_, i) => ({ ...valid.texts[0], id: `t${i}` })) };
    const result = apply(over, { type: "moveClip", clipId: "b", toIndex: 0 });
    expect(result.rejected).toBeUndefined();
    expect(result.warning).toBeTruthy();
    expect(result.timeline.clips[0].id).toBe("b");
  });

  it("but a command that adds a new problem to it is still refused", () => {
    const valid = reel();
    const clips = Array.from({ length: 100 }, (_, i) => ({ ...valid.clips[2], id: `p${i}` }));
    const over = { ...valid, clips, texts: Array.from({ length: 51 }, (_, i) => ({ ...valid.texts[0], id: `t${i}` })) };
    const result = apply(over, { type: "duplicateClip", clipId: "p0", newId: "p-copy" });
    expect(result.rejected).toMatch(/clips/);
    expect(result.timeline).toBe(over);
  });
});

describe("review fixes (PR #191)", () => {
  function twoClips(texts: object[]): Timeline {
    return parseTimeline({
      version: 1,
      clips: [
        { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
        { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
      ],
      texts,
      music: null,
    });
  }

  it("a spanning caption shortened inside a trim gesture gets its time back when the gesture undoes the trim", () => {
    const start = twoClips([{ id: "cap", text: "Just listed", startMs: 3000, endMs: 7500 }]);
    const step = (timeline: Timeline, sourceEndMs: number) =>
      applyCommand(timeline, { type: "trimClip", clipId: "a", window: { sourceStartMs: 0, sourceEndMs } }, { ...ctx, gestureBase: start }).timeline;
    const short = step(start, 500);
    expect(times(short).cap).toEqual([3000, 4500]);
    expect(times(step(short, 4000)).cap).toEqual([3000, 7500]);
  });

  it("AI steps that shorten the reel on the way do not shorten a spanning caption", () => {
    const start = twoClips([{ id: "cap", text: "Just listed", startMs: 3000, endMs: 7500 }]);
    const plan = applyAiEditPlan(start, { ops: [op({ op: "trim", clip: 1, startMs: 0, endMs: 600 }), op({ op: "trim", clip: 1, startMs: 0, endMs: 4000 })], note: "" }, { assets, songs: [], newId: () => "n" });
    expect(times(plan.timeline).cap).toEqual([3000, 7500]);
  });

  it("a caption deleted on purpose does not come back", () => {
    const start = twoClips([{ id: "cap", text: "Just listed", startMs: 3000, endMs: 7500 }]);
    const plan = applyAiEditPlan(start, { ops: [op({ op: "removeText", text: 1 }), op({ op: "trim", clip: 1, startMs: 0, endMs: 600 })], note: "" }, { assets, songs: [], newId: () => "n" });
    expect(plan.timeline.texts).toEqual([]);
  });

  it("trimming a clip keeps its title inside it, so it still follows the clip later", () => {
    const start = twoClips([{ id: "t", text: "Hall", startMs: 2500, endMs: 3500 }]);
    const trimmed = apply(start, { type: "trimClip", clipId: "a", window: { sourceStartMs: 0, sourceEndMs: 2000 } }).timeline;
    const title = trimmed.texts[0];
    expect(title.endMs).toBeLessThanOrEqual(2000);
    expect(textAttachment(trimmed, title)).toEqual({ kind: "clip", clipId: "a" });
    const moved = apply(trimmed, { type: "moveClip", clipId: "a", toIndex: 1 }).timeline;
    expect(times(moved).t).toEqual([title.startMs + 4000, title.endMs + 4000]);
  });

  it("a speed-up that leaves no room for a room label still applies", () => {
    const labelled = parseTimeline({
      version: 1,
      clips: [
        { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 500, room: "hall" },
        { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, room: "kitchen" },
      ],
      texts: [{ id: "room-b", text: "Kitchen", startMs: 700, endMs: 4500 }],
      music: null,
    });
    const result = apply(labelled, { type: "setSpeed", clipId: "a", speed: 3 });
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.clips[0].speed).toBe(3);
  });
});

describe("split, duplicate and delete keep pins valid", () => {
  function pinned(): Timeline {
    // A title tracked on source 3–5 s of v1, shown over reel 1–3 s of clip a (source 2–8 s).
    return parseTimeline({
      ...reel(),
      texts: [{ id: "pin", text: "Pool", startMs: 1000, endMs: 3000, pin: { assetId: "v1", fromMs: 3000, toMs: 5000 }, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.1, y: 0 }] }],
    });
  }

  it("split before the title: it moves to the second piece and still sees its tracked frames", () => {
    const { timeline } = apply(pinned(), { type: "splitClip", atMs: 600, newId: "a2" });
    expect(timeline.clips.map((clip) => clip.id)).toEqual(["a", "a2", "b", "c"]);
    const text = timeline.texts[0];
    expect([text.startMs, text.endMs]).toEqual([1000, 3000]);
    expect(textAttachment(timeline, text)).toEqual({ kind: "clip", clipId: "a2" });
    expect(pinnedProgress(timeline, text, 1000)).toBeCloseTo(0, 1);
    expect(pinnedProgress(timeline, text, 2990)).toBeCloseTo(1, 1);
  });

  it("split through the title: it keeps its times and runs on over the second piece of the same source", () => {
    const { timeline } = apply(pinned(), { type: "splitClip", atMs: 2000, newId: "a2" });
    const text = timeline.texts[0];
    expect([text.startMs, text.endMs]).toEqual([1000, 3000]);
    expect(pinnedProgress(timeline, text, 2500)).toBeCloseTo(0.75, 1);
    expect(text.pin).toEqual(pinned().texts[0].pin);
  });

  it("a text in the second half of a split photo follows the new piece", () => {
    const photo = parseTimeline({ ...reel(), texts: [{ id: "late", text: "Pool", startMs: 12000, endMs: 12500 }] });
    // c is the photo at 10–13 s; split at 11 s.
    const split = apply(photo, { type: "splitClip", atMs: 11000, newId: "c2" }).timeline;
    expect(times(split).late).toEqual([12000, 12500]);
    const moved = apply(split, { type: "moveClip", clipId: "c2", toIndex: 0 }).timeline;
    expect(times(moved).late).toEqual([1000, 1500]);
  });

  it("duplicating leaves the title with the original clip instance", () => {
    const { timeline } = apply(pinned(), { type: "duplicateClip", clipId: "a", newId: "a-copy" });
    expect(timeline.clips.map((clip) => clip.id)).toEqual(["a", "a-copy", "b", "c"]);
    expect(times(timeline).pin).toEqual([1000, 3000]);
    expect(textAttachment(timeline, timeline.texts[0])).toEqual({ kind: "clip", clipId: "a" });
  });

  it("slowing the clip keeps the title on the same tracked frames", () => {
    const { timeline } = apply(pinned(), { type: "setSpeed", clipId: "a", speed: 0.5 });
    const text = timeline.texts[0];
    expect([text.startMs, text.endMs]).toEqual([2000, 6000]);
    expect(pinnedProgress(timeline, text, 2000)).toBeCloseTo(0, 1);
    expect(pinnedProgress(timeline, text, 6100)).not.toBe(PINNED_ELSEWHERE);
  });

  it("deleting the clip before it keeps an attached title over its picture", () => {
    const { timeline } = apply(reel(), { type: "deleteClip", clipId: "a" });
    expect(times(timeline).kitchen).toEqual([1000, 3000]);
    // The caption keeps its seconds, cut short at the new end (7 s).
    expect(times(timeline).caption).toEqual([4000, 7000]);
  });
});
