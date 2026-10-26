import { describe, expect, it } from "vitest";
import { applyAiEditPlan, describeReel, fakeAiEditPlan, type AiAsset, type AiEditOp, type AiSong } from "../src/ai-edit";
import { TAG_Y, clipDurationMs, coverMs, keepTextsClearOfCard, parseTimeline, referencedAssetIds, splitClip, textUnderCard, type Timeline } from "../src/timeline";
import { instagramIssues } from "../src/instagram";

// The ten things people ask for most (2026-10-14): more cuts from one video,
// a closer crop, the cover frame, a logo, a status sticker, text over one
// shot, how text arrives, the new looks, the facts strip, and the caption.

const assets: Record<string, AiAsset> = {
  walk: { id: "walk", kind: "VIDEO", title: "walkthrough", durationMs: 20000, isPano: false, bpm: null, beatOffsetMs: null, room: "living room" },
  kitchen: { id: "kitchen", kind: "IMAGE", title: "kitchen", durationMs: null, isPano: false, bpm: null, beatOffsetMs: null, room: "kitchen" },
  pool: { id: "pool", kind: "IMAGE", title: "pool", durationMs: null, isPano: false, bpm: null, beatOffsetMs: null, room: "pool" },
  logo: { id: "logo", kind: "IMAGE", title: "acme-realty-logo", durationMs: null, isPano: false, bpm: null, beatOffsetMs: null },
};
const unused: AiAsset[] = [assets.logo];
const songs: AiSong[] = [];

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "walk", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 6000, room: "living room" },
      { id: "c2", assetId: "kitchen", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, room: "kitchen" },
      { id: "c3", assetId: "pool", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, room: "pool" },
    ],
    texts: [{ id: "t1", text: "Just listed", startMs: 0, endMs: 4000, style: "headline" }],
    music: null,
    details: { price: "$1,250,000", beds: "3", baths: "2", area: "2,400 sq ft", address: "12 Lake Dr", contact: "", placement: "none" },
  });
}

const blank: Omit<AiEditOp, "op"> = {
  clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
  volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
  assetId: null, order: null, pieces: null, atClip: null, animation: null, zoom: null, corner: null, yaw: null, sweep: null,
};
const op = (fields: Partial<AiEditOp> & { op: AiEditOp["op"] }): AiEditOp => ({ ...blank, ...fields });
let n = 0;
const run = (ops: AiEditOp[], timeline = reel(), caption: string | null = null) => applyAiEditPlan(timeline, { ops, note: "", caption }, { assets, songs, unused, newId: () => `n${++n}` });

describe("1. more cuts from one video", () => {
  it("splitClip gives shots from different parts of the source, in order", () => {
    const next = splitClip(reel(), "c1", 3, () => `s${++n}`, 20000);
    expect(next.clips).toHaveLength(5);
    const pieces = next.clips.slice(0, 3);
    expect(pieces.map((clip) => clip.assetId)).toEqual(["walk", "walk", "walk"]);
    expect(pieces.every((clip) => clipDurationMs(clip) === clipDurationMs(pieces[0]))).toBe(true);
    // Later pieces come from later in the video.
    expect(pieces[0].sourceStartMs).toBeLessThan(pieces[1].sourceStartMs);
    expect(pieces[1].sourceStartMs).toBeLessThan(pieces[2].sourceStartMs);
    expect(pieces[2].sourceEndMs).toBeLessThanOrEqual(20000);
    expect(pieces[1].id).not.toBe(pieces[0].id);
  });

  it("the split op reports the shots and leaves a photo alone", () => {
    const { timeline, applied, skipped } = run([op({ op: "split", clip: 1, pieces: 2 }), op({ op: "split", clip: 2, pieces: 2 })]);
    expect(timeline.clips).toHaveLength(4);
    expect(applied).toEqual(["clip 1 (living room) cut into 2 shots"]);
    expect(skipped).toEqual(["split: clip 3 (kitchen) is a photo; duplicate it instead"]);
    // The hook still covers the first shot.
    expect(timeline.texts[0].startMs).toBe(0);
  });

  it("a duplicate with a window shows another part of the video, not the same seconds", () => {
    const { timeline, applied } = run([op({ op: "duplicate", clip: 1, startMs: 10000, lengthMs: 2000, toPosition: 2 })]);
    expect(timeline.clips[1]).toMatchObject({ assetId: "walk", sourceStartMs: 10000, sourceEndMs: 12000 });
    expect(applied[0]).toBe("clip 1 (living room) duplicated (10.0 s–12.0 s of the source)");
  });
});

describe("2. a closer crop", () => {
  it("zooms one clip or all of them", () => {
    const one = run([op({ op: "zoom", clip: 2, zoom: 1.3 })]);
    expect(one.timeline.clips.map((clip) => clip.zoom)).toEqual([1, 1.3, 1]);
    expect(one.applied).toEqual(["clip 2 (kitchen): zoom 1.3x"]);
    const all = run([op({ op: "zoom", clip: 0, zoom: 1.6 })]);
    expect(all.timeline.clips.every((clip) => clip.zoom === 1.6)).toBe(true);
  });
});

describe("3. the cover frame", () => {
  it("picks a clip and a moment, and the frame moves with the clip", () => {
    const { timeline, applied } = run([op({ op: "cover", clip: 3, startMs: 1000 })]);
    expect(timeline.cover).toEqual({ clipId: "c3", offsetMs: 1000 });
    expect(coverMs(timeline)).toBe(7000 + 1000);
    expect(applied).toEqual(["cover: clip 3 (pool), 1.0 s in"]);
    const moved = run([op({ op: "move", clip: 3, toPosition: 1 })], timeline);
    expect(coverMs(moved.timeline)).toBe(1000);
    const gone = run([op({ op: "remove", clip: 3 })], timeline);
    expect(gone.timeline.cover).toBeNull();
    expect(coverMs(gone.timeline)).toBe(700);
  });

  it("the usual cover is 0.7 s in, and inside a very short reel", () => {
    expect(coverMs(reel())).toBe(700);
    const tiny = parseTimeline({ ...reel(), clips: [{ ...reel().clips[1], sourceEndMs: 600 }] });
    expect(coverMs(tiny)).toBe(500);
  });
});

describe("4. a logo", () => {
  it("takes an unused image into a corner, and the render needs that file", () => {
    const { timeline, applied } = run([op({ op: "logo", assetId: "logo", corner: "bottom-left", size: 0.15 })]);
    expect(timeline.logo).toEqual({ assetId: "logo", corner: "bottom-left", size: 0.15 });
    expect(applied).toEqual(['logo "acme-realty-logo" at the bottom-left']);
    expect(referencedAssetIds(timeline)).toContain("logo");
    const removed = run([op({ op: "logo", assetId: null })], timeline);
    expect(removed.timeline.logo).toBeNull();
    expect(removed.applied).toEqual(["logo removed"]);
  });

  it("refuses a video or a missing image", () => {
    const { skipped } = run([op({ op: "logo", assetId: "walk" })]);
    expect(skipped).toEqual(["logo: no image walk"]);
  });
});

describe("5. a status sticker", () => {
  it("is capitals at the top of the safe area over the first shot", () => {
    const { timeline, applied } = run([op({ op: "addText", content: "Price drop", style: "tag" })]);
    const tag = timeline.texts.find((text) => text.style === "tag")!;
    expect(tag).toMatchObject({ text: "PRICE DROP", y: TAG_Y, size: 0.9, startMs: 0, endMs: 4000 });
    expect(applied).toEqual(['added text "Price drop"']);
    // Changing the sticker keeps it a sticker.
    const sold = run([op({ op: "editText", text: 2, content: "sold" })], timeline);
    expect(sold.timeline.texts[1].text).toBe("SOLD");
  });
});

describe("6. text over one shot", () => {
  it("atClip puts text from the shot's first frame to its last, so 'at the end' is the last clip", () => {
    const { timeline } = run([op({ op: "addText", content: "DM for a private tour", style: "box", atClip: 3, y: 0.6 })]);
    expect(timeline.texts[1]).toMatchObject({ text: "DM for a private tour", startMs: 7000, endMs: 10000, y: 0.6 });
    // With the details card showing at the end, the line goes above the card instead of under it.
    const carded = parseTimeline({ ...reel(), details: { ...reel().details!, placement: "end" } });
    const aboveCard = run([op({ op: "addText", content: "DM for a private tour", style: "box", atClip: 3, y: 0.6 })], carded);
    expect(aboveCard.timeline.texts[1].y).toBe(0.42);
    const over = run([op({ op: "editText", text: 1, atClip: 2 })], timeline);
    expect(over.timeline.texts[0]).toMatchObject({ startMs: 4000, endMs: 7000 });
  });

  it("and it moves with the shot when the reel is re-timed", () => {
    const { timeline } = run([op({ op: "addText", content: "The view", atClip: 3 })]);
    const longer = run([op({ op: "trim", clip: 2, lengthMs: 5000 })], timeline);
    expect(longer.timeline.texts[1]).toMatchObject({ startMs: 9000, endMs: 12000 });
  });
});

describe("7. how text arrives", () => {
  it("sets an animation on new and existing text, and says so in the description", () => {
    const { timeline } = run([op({ op: "editText", text: 1, animation: "type" }), op({ op: "addText", content: "Quiet street", style: "elegant", animation: "rise", atClip: 2 })]);
    expect(timeline.texts.map((text) => text.animation)).toEqual(["type", "rise"]);
    expect(describeReel({ title: "r", timeline, assets, songs })).toContain('"Just listed", style headline, color #ffffff, size 1, y 0.40, animation type');
  });
});

describe("8. the new looks", () => {
  it("golden, dusk and crisp are looks like any other", () => {
    for (const filter of ["golden", "dusk", "crisp"] as const) {
      const { timeline, skipped } = run([op({ op: "look", clip: 0, filter })]);
      expect(skipped).toEqual([]);
      expect(timeline.clips.every((clip) => clip.filter === filter)).toBe(true);
    }
  });
});

describe("9. the facts strip", () => {
  it("facts kept unseen are described as known, and can be shown throughout", () => {
    expect(describeReel({ title: "r", timeline: reel(), assets, songs })).toContain("Details: price $1,250,000, beds 3, baths 2, area 2,400 sq ft, address 12 Lake Dr; known but not shown (placement none).");
    const { timeline, applied } = run([op({ op: "details", details: { price: null, beds: null, baths: null, area: null, address: null, contact: null, placement: "throughout" } })]);
    expect(timeline.details?.placement).toBe("throughout");
    expect(applied).toEqual(["details card updated (placement)"]);
    expect(describeReel({ title: "r", timeline, assets, songs })).toContain("shown as a strip at the top throughout");
  });
});

describe("10. the caption", () => {
  it("comes back with the plan and needs no operation", () => {
    const { caption, applied, timeline } = run([], reel(), "$1,250,000 · 12 Lake Dr\nDM for a tour.\n\n#realestate");
    expect(caption).toBe("$1,250,000 · 12 Lake Dr\nDM for a tour.\n\n#realestate");
    expect(applied).toEqual(["caption written"]);
    expect(timeline).toEqual(reel());
  });
});

describe("the stand-in planner knows the ten asks", () => {
  const plan = (request: string) => fakeAiEditPlan(request, reel(), songs, unused);
  it("sticker, ending text, zoom, split, cover, logo, typing, strip, caption, golden", () => {
    expect(plan("add a price drop sticker").ops[0]).toMatchObject({ op: "addText", style: "tag", content: "PRICE DROP" });
    expect(plan('put "DM for a tour" at the end').ops[0]).toMatchObject({ op: "addText", content: "DM for a tour", atClip: 3 });
    expect(plan("zoom in on the kitchen a bit").ops[0]).toMatchObject({ op: "zoom", clip: 2, zoom: 1.3 });
    expect(plan("cut the living room video into 3 shots").ops[0]).toMatchObject({ op: "split", clip: 1, pieces: 3 });
    expect(plan("use the pool shot as the cover").ops[0]).toMatchObject({ op: "cover", clip: 3 });
    expect(plan("add my logo bottom left").ops[0]).toMatchObject({ op: "logo", assetId: "logo", corner: "bottom-left" });
    expect(plan("make the title type in letter by letter").ops[0]).toMatchObject({ op: "editText", text: 1, animation: "type" });
    expect(plan("keep the price on screen the whole time").ops[0]).toMatchObject({ op: "details", details: { placement: "throughout" } });
    expect(plan("write the caption").caption).toContain("#realestate");
    expect(plan("make it look like golden hour").ops[0]).toMatchObject({ op: "look", filter: "golden" });
  });

  // The e2e flow uploads the logo in its sheet (so it is on the reel, not unused) and then asks to move it.
  it("moves the logo the reel already has, even when no unused logo is left", () => {
    const withLogo = run([op({ op: "logo", assetId: "logo", corner: "top-right" })]).timeline;
    const moved = fakeAiEditPlan("move the logo to the bottom left", withLogo, songs, []);
    expect(moved.ops[0]).toMatchObject({ op: "logo", assetId: "logo", corner: "bottom-left" });
    expect(run(moved.ops, withLogo).timeline.logo).toMatchObject({ assetId: "logo", corner: "bottom-left" });
  });
});

describe("nothing hides behind the details card", () => {
  // Reel 36 (2026-10-14): the plan added "OPEN HOUSE" low over the last shot, then the card; the card covered it.
  it("a text added before the card in the same plan still moves up out of its way", () => {
    const { timeline } = run([
      op({ op: "addText", content: "OPEN HOUSE • SAT 1–3 PM", style: "box", atClip: 3, y: 0.76 }),
      op({ op: "details", details: { price: null, beds: null, baths: null, area: null, address: null, contact: null, placement: "end" } }),
    ]);
    const line = timeline.texts.find((text) => text.text.startsWith("OPEN HOUSE"))!;
    expect(line.y).toBe(0.42);
    expect(textUnderCard(timeline, line)).toBe(false);
    expect(instagramIssues(timeline).filter((issue) => issue.code === "text-under-card")).toEqual([]);
  });

  it("moves to a free height when the hook already holds the middle", () => {
    const carded = parseTimeline({
      ...reel(),
      details: { ...reel().details!, placement: "end" },
      texts: [
        { id: "hook", text: "Just listed", startMs: 0, endMs: 10000, y: 0.42, style: "headline" },
        { id: "low", text: "DM for a tour", startMs: 8000, endMs: 10000, y: 0.7, style: "box" },
      ],
    });
    const cleared = keepTextsClearOfCard(carded);
    expect(cleared.texts.find((text) => text.id === "low")!.y).toBe(0.34);
    expect(cleared.texts.find((text) => text.id === "hook")!.y).toBe(0.42);
  });

  it("a text placed under the card by hand is flagged before export, and room labels are not", () => {
    const carded = parseTimeline({
      ...reel(),
      details: { ...reel().details!, placement: "end" },
      texts: [
        { id: "low", text: "DM for a tour", startMs: 8000, endMs: 10000, y: 0.7, style: "box" },
        { id: "room-c3", text: "Pool", startMs: 7200, endMs: 10000, y: 0.74, style: "box" },
      ],
    });
    const issues = instagramIssues(carded).filter((issue) => issue.code === "text-under-card");
    expect(issues.map((issue) => issue.textId)).toEqual(["low"]);
    expect(issues[0].level).toBe("warning");
    // With the card kept unseen there is nothing to hide behind.
    expect(instagramIssues({ ...carded, details: { ...carded.details!, placement: "none" } }).some((issue) => issue.code === "text-under-card")).toBe(false);
  });
});

describe("transitions from an ask (whips retired, ADR 0082)", () => {
  it("puts a soft dissolve on the cuts, never on the first clip", () => {
    const result = run([op({ op: "transition", clip: 0, transition: "softDissolve" })]);
    expect(result.timeline.clips.map((clip) => clip.transitionIn)).toEqual(["cut", "softDissolve", "softDissolve"]);
    expect(parseTimeline(result.timeline).clips[1].transitionIn).toBe("softDissolve");
  });

  it("the stand-in hears smooth transitions as a soft dissolve, and offers nothing for a whoosh or a swipe", () => {
    for (const ask of ["smooth transitions please", "blend the shots"]) {
      const plan = fakeAiEditPlan(ask, reel(), songs);
      expect(plan.ops.find((o) => o.op === "transition")?.transition).toBe("softDissolve");
    }
    for (const ask of ["add whoosh transitions", "swipe between the shots"]) {
      expect(fakeAiEditPlan(ask, reel(), songs).ops.find((o) => o.op === "transition")).toBeUndefined();
    }
  });
});
