import { describe, expect, it } from "vitest";
import type { AiAsset, AiSong } from "../src/ai-edit";
import { autopilotRequest, autopilotStyle, detailsFromInfo, finishAutopilot, pickSong, ruleCut, usableCut } from "../src/autopilot";
import { clipDurationMs, parseTimeline, showsDetailsCard, timelineDurationMs } from "../src/timeline";

const assets: Record<string, AiAsset> = {
  front: { id: "front", kind: "VIDEO", title: "02_Exterior_Facade_Palms", durationMs: 12000, isPano: false, bpm: null, beatOffsetMs: null },
  kitchen: { id: "kitchen", kind: "IMAGE", title: "kitchen", durationMs: null, isPano: false, bpm: null, beatOffsetMs: null },
  pool: { id: "pool", kind: "VIDEO", title: "05_Balcony_Pool_Lagoon_View", durationMs: 4000, isPano: false, bpm: null, beatOffsetMs: null },
  bed: { id: "bed", kind: "VIDEO", title: "bedroom", durationMs: 7000, isPano: false, bpm: null, beatOffsetMs: null },
  calm: { id: "calm", kind: "AUDIO", title: "Fretless", durationMs: 150000, isPano: false, bpm: 100, beatOffsetMs: 0 },
  bright: { id: "bright", kind: "AUDIO", title: "Carefree", durationMs: 120000, isPano: false, bpm: 96, beatOffsetMs: 120 },
};
const songs: AiSong[] = [
  { id: "calm", title: "Fretless", bpm: 100, mood: "slow and smooth; late-night, classy" },
  { id: "bright", title: "Carefree", bpm: 96, mood: "light, bouncy ukulele; cheerful" },
];

// Shots as they arrive from the phone: in picking order, full length, nothing else.
function picked() {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "kitchen", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
      { id: "c2", assetId: "pool", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
      { id: "c3", assetId: "front", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 12000 },
      { id: "c4", assetId: "bed", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 7000 },
    ],
    texts: [],
    music: null,
  });
}

let n = 0;
const context = (styleId: string, info = {}) => ({ assets, songs, info, style: autopilotStyle(styleId), newId: () => `n${++n}` });

describe("ruleCut", () => {
  it("opens outside, ends on the view, keeps one shot per video, and finishes the reel", () => {
    const cut = ruleCut(picked(), context("just-listed", { price: "$1,250,000", address: "1427 Lakeview Dr" }));
    const names = cut.clips.map((clip) => clip.assetId);
    expect(names[0]).toBe("front");
    expect(names.at(-1)).toBe("pool");
    // Four clips: each long video is one shot (no mid-clip split of a longer shoot).
    expect(names).toHaveLength(4);
    expect(names.filter((name) => name === "front")).toHaveLength(1);
    expect(names.filter((name) => name === "bed")).toHaveLength(1);
    expect(cut.music?.assetId).toBe("bright");
    expect(cut.texts[0]).toMatchObject({ text: "Just listed", style: "headline", y: 0.42, startMs: 0, endMs: clipDurationMs(cut.clips[0]) });
    expect(cut.details).toMatchObject({ price: "$1,250,000", address: "1427 Lakeview Dr", placement: "end" });
    expect(usableCut(cut)).toBe(true);
  });

  it("the luxury style is slower, calmer, and leaves the card off", () => {
    const cut = ruleCut(picked(), context("privacy", { price: "$4,000,000" }));
    expect(cut.music?.assetId).toBe("calm");
    expect(cut.texts.map((text) => [text.text, text.style])).toEqual([["the privacy I want", "elegant"]]);
    // The price is kept for a later card or caption, but no card shows.
    expect(cut.details).toMatchObject({ price: "$4,000,000", placement: "none" });
    expect(showsDetailsCard(cut.details)).toBe(false);
    expect(Math.min(...cut.clips.map(clipDurationMs))).toBeGreaterThan(2500);
  });

  it("keeps the reel under the style's length", () => {
    const many = parseTimeline({ ...picked(), clips: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, assetId: "kitchen", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 })) });
    const cut = ruleCut(many, context("just-listed"));
    expect(timelineDurationMs(cut)).toBeLessThanOrEqual(30000);
  });
});

describe("finishAutopilot", () => {
  it("adds only what the model left out", () => {
    const fromModel = parseTimeline({ ...picked(), texts: [{ id: "h", text: "Welcome home", startMs: 0, endMs: 2000 }] });
    const { timeline, added } = finishAutopilot(fromModel, context("open-house", { openHouse: "Sat 1–3 pm" }));
    expect(timeline.texts.map((text) => text.text)).toEqual(["Welcome home"]);
    expect(timeline.music?.assetId).toBe("bright");
    expect(timeline.details).toMatchObject({ contact: "Open home Sat 1–3 pm" });
    expect(added).toEqual(["music: Carefree, cuts on the beat", "details card"]);
  });
});

describe("repeats", () => {
  it("a photo the model used twice is shown once", () => {
    const twice = parseTimeline({ ...picked(), clips: [...picked().clips, { id: "again", assetId: "kitchen", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000 }] });
    const { timeline, added } = finishAutopilot(twice, context("just-listed"));
    expect(timeline.clips.filter((clip) => clip.assetId === "kitchen")).toHaveLength(1);
    expect(added[0]).toBe("1 repeated photo taken out");
  });
});

describe("the request and the facts", () => {
  it("tells the model the facts and not to ask", () => {
    const text = autopilotRequest("open-house", { openHouse: "Saturday 1–3 pm", address: "1427 Lakeview Dr" });
    expect(text).toContain("address: 1427 Lakeview Dr; open home: Saturday 1–3 pm");
    expect(text).toContain("Do not ask me anything");
    expect(text).toContain("always return a cut");
    expect(text).not.toContain("Ask me for the day");
  });

  it("no facts means no card, and a song is always found", () => {
    expect(detailsFromInfo({}, autopilotStyle("just-listed"))).toBeNull();
    expect(pickSong(songs, autopilotStyle("walkthrough"))?.id).toBeDefined();
  });
});
