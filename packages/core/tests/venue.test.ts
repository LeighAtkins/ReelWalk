import { describe, expect, it } from "vitest";
import {
  buildVenueReel,
  captionForVenue,
  clipStartsMs,
  instagramIssues,
  parseTimeline,
  timelineDurationMs,
  VENUE_VIBES,
  venueDetailsSchema,
  venueVibeById,
  type VenueClip,
} from "../src";

const clips: VenueClip[] = [
  { assetId: "front", kind: "VIDEO", durationMs: 12_000 },
  { assetId: "pizza", kind: "VIDEO", durationMs: 8_000 },
  { assetId: "pour", kind: "VIDEO", durationMs: 1_200 },
  { assetId: "room", kind: "IMAGE", durationMs: null },
  { assetId: "dessert", kind: "VIDEO", durationMs: 9_000 },
];

const details = venueDetailsSchema.parse({
  name: "Café Lumen",
  cuisine: "Neapolitan pizza",
  priceFrom: "$12",
  address: "14 Harbour St",
  handle: "cafelumen",
  dishes: [
    { name: "Margherita", price: "$14" },
    { name: "Burrata", price: "$11" },
    { name: "Tiramisu", price: "" },
  ],
});

describe("venue vibes", () => {
  it("every vibe fills its templates and names a song", () => {
    for (const vibe of VENUE_VIBES) {
      expect(vibe.song).not.toBe("");
      expect(venueVibeById(vibe.id)).toBe(vibe);
    }
    expect(venueVibeById("nope")).toBeUndefined();
  });
});

describe("buildVenueReel", () => {
  const vibe = venueVibeById("golden-hour")!;

  it("needs at least two clips", () => {
    expect(buildVenueReel({ clips: clips.slice(0, 1), details, vibe })).toBeNull();
  });

  it("cuts each clip to the vibe, never longer than its source, and is a valid, exportable timeline", () => {
    const timeline = buildVenueReel({ clips, details, vibe })!;
    expect(() => parseTimeline(timeline)).not.toThrow();
    expect(timeline.clips).toHaveLength(5);
    expect(timeline.clips.map((clip) => clip.sourceEndMs)).toEqual([2600, 2600, 1200, 2600, 2600]);
    expect(timeline.clips.every((clip) => clip.filter === "warm")).toBe(true);
    expect(timeline.clips[3]!.motion).not.toBe("none");
    expect(instagramIssues(timeline, "").filter((issue) => issue.level === "error")).toEqual([]);
  });

  it("opens with the hook, labels one dish per clip after it, and ends on the details card", () => {
    const timeline = buildVenueReel({ clips, details, vibe })!;
    const hook = timeline.texts.find((text) => text.id === "hook")!;
    expect(hook.text).toBe("Dinner at Café Lumen\nstarts like this");
    expect(hook.startMs).toBeLessThan(hook.endMs);

    const dishes = timeline.texts.filter((text) => text.id.startsWith("dish-"));
    expect(dishes.map((text) => text.text)).toEqual(["Margherita · $14", "Burrata · $11", "Tiramisu"]);
    // Labels start at successive clips and never overlap each other.
    const starts = clipStartsMs(timeline);
    dishes.forEach((label, index) => {
      expect(label.startMs).toBeGreaterThanOrEqual(index === 0 ? hook.endMs : starts[index]!);
      if (index > 0) expect(label.startMs).toBeGreaterThanOrEqual(dishes[index - 1]!.endMs);
    });

    expect(timeline.details).toMatchObject({ price: "from $12", address: "14 Harbour St", contact: "Book a table · @cafelumen", placement: "end" });
    const total = timelineDurationMs(timeline);
    expect(dishes.every((label) => label.endMs <= total)).toBe(true);
  });

  it("snaps cuts to the beat when the song has one, and ducks the clips under the music", () => {
    const music = { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 120, beatOffsetMs: 0 };
    const timeline = buildVenueReel({ clips, details, vibe, music })!;
    // 120 bpm: a beat every 500 ms, so every clip boundary lands on a multiple of 500.
    for (const start of clipStartsMs(timeline)) expect(start % 500).toBe(0);
    expect(timeline.clips.every((clip) => clip.volume === 0.15)).toBe(true);
    expect(timeline.music).toEqual(music);
  });

  it("drops the handle from the call to action when there is none", () => {
    const timeline = buildVenueReel({ clips, details: { ...details, handle: "" }, vibe })!;
    expect(timeline.details!.contact).toBe("Book a table");
  });
});

describe("captionForVenue", () => {
  it("reads as a post: lead, cuisine and price, the menu, where, hashtags, credit", () => {
    const caption = captionForVenue(venueVibeById("street-food")!, details, "Funkorama by Kevin MacLeod");
    expect(caption).toContain("Café Lumen is open.");
    expect(caption).toContain("Neapolitan pizza, from $12");
    expect(caption).toContain("• Margherita · $14\n• Burrata · $11\n• Tiramisu");
    expect(caption).toContain("14 Harbour St · @cafelumen");
    expect(caption).toContain("#streetfood");
    expect(caption.endsWith("Music: Funkorama by Kevin MacLeod")).toBe(true);
  });
});
