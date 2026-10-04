import { describe, expect, it } from "vitest";
import { buildTourReel, captionForVibe, instagramIssues, listingDetailsSchema, normalizePlan, vibeById, VIBES, type TourShot } from "../src";

const { plan } = normalizePlan([[[0, 0], [10, 0], [10, 10], [0, 10]]]);
const shot = (assetId: string, room: string, x: number, y: number): TourShot => ({ assetId, room, spot: { x, y, heading: 0 }, isPano: true });
const shots = [
  shot("living", "living room", 0.5, 0.5),
  shot("dining", "dining room", 0.3, 0.5),
  shot("kitchen", "kitchen", 0.5, 0.2),
  shot("bed", "bedroom", 0.8, 0.8),
  shot("bath", "bathroom", 0.9, 0.2),
  shot("bonus", "bonus room", 0.2, 0.8),
  shot("garage", "garage", 0.1, 0.1),
];
const details = listingDetailsSchema.parse({ price: "$485,000", beds: "3", baths: "2", area: "1,640 sq ft" });

describe("vibes", () => {
  it("has five, each with its own song, look and opening line", () => {
    expect(VIBES).toHaveLength(5);
    for (const key of ["id", "song", "hook"] as const) expect(new Set(VIBES.map((vibe) => vibe[key])).size).toBe(5);
  });

  it.each(VIBES.map((vibe) => [vibe.id, vibe] as const))("%s builds a reel Instagram accepts", (_id, vibe) => {
    const timeline = buildTourReel({ shots, plan, details, vibe })!;
    const stops = timeline.clips.filter((clip) => clip.room !== null);
    expect(stops.length).toBeLessThanOrEqual(vibe.maxStops);
    expect(timeline.clips.every((clip) => clip.filter === vibe.filter)).toBe(true);
    expect(timeline.texts[0]).toMatchObject({ id: "hook", text: vibe.hook });
    expect(timeline.plan?.visible).toBe(vibe.plan);
    expect(timeline.details?.contact).toBe(vibe.callToAction);
    // No room name is on screen while the hook is.
    expect(timeline.texts.slice(1).every((text) => text.startMs >= timeline.texts[0].endMs)).toBe(true);
    const caption = captionForVibe(vibe, details, "Song credit");
    expect(instagramIssues(timeline, caption).filter((issue) => issue.level === "error")).toEqual([]);
  });

  it("only visits the rooms the vibe is about, under its own names", () => {
    const timeline = buildTourReel({ shots, plan, vibe: vibeById("host") })!;
    expect(timeline.clips.map((clip) => clip.assetId).sort()).toEqual(["bonus", "dining", "kitchen", "living"]);
    expect(timeline.texts.map((text) => text.text)).toContain("Dinner here");
  });

  it("shows no room names when the vibe has none", () => {
    const timeline = buildTourReel({ shots, plan, vibe: vibeById("blank-canvas") })!;
    expect(timeline.texts.map((text) => text.id)).toEqual(["hook"]);
  });

  it("writes a caption with the facts, the call to action and the music credit", () => {
    const caption = captionForVibe(vibeById("numbers")!, details, "“Funkorama” Kevin MacLeod");
    expect(caption).toContain("$485,000 · 3 bed · 2 bath · 1,640 sq ft");
    expect(caption).toContain("DM “COMPS” for rent estimates");
    expect(caption.endsWith("Music: “Funkorama” Kevin MacLeod")).toBe(true);
  });
});
