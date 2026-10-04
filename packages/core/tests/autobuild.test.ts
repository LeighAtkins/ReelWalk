import { describe, expect, it } from "vitest";
import {
  buildTourReel,
  captionFromDetails,
  clipStartsMs,
  detailFacts,
  hasDetails,
  listingDetailsSchema,
  normalizePlan,
  parseTimeline,
  walkOrder,
  type TourShot,
} from "../src";

const shot = (assetId: string, room: string | null, x: number, y: number, aim?: number): TourShot => ({
  assetId,
  room,
  spot: { x, y, heading: 0, ...(aim === undefined ? {} : { aim }) },
  isPano: true,
});

const shots: TourShot[] = [
  shot("closet", "closet", 0.1, 0.1),
  shot("bed-far", "bedroom", 0.9, 0.9),
  shot("kitchen", "kitchen", 0.5, 0.2, 40),
  shot("bed-near", "bedroom", 0.55, 0.3),
  shot("living", "living room", 0.5, 0.5),
  shot("unknown", null, 0.2, 0.2),
];

describe("walkOrder", () => {
  it("goes through room types in viewing order and skips closets and unknown rooms", () => {
    expect(walkOrder(shots).map((item) => item.assetId)).toEqual(["living", "kitchen", "bed-near", "bed-far"]);
  });
});

describe("buildTourReel", () => {
  const { plan } = normalizePlan([[[0, 0], [10, 0], [10, 10], [0, 10]]]);

  it("builds a draft with sweeps, the plan, room names and fades", () => {
    const timeline = buildTourReel({ shots, plan })!;
    expect(timeline.clips).toHaveLength(4);
    expect(timeline.clips[0].transitionIn).toBe("cut");
    expect(timeline.clips[1].transitionIn).toBe("fade");
    // The kitchen sweep ends on its window.
    expect(timeline.clips[1].pano).toMatchObject({ yawStart: -35, yawEnd: 40 });
    expect(timeline.plan?.visible).toBe(true);
    expect(timeline.texts.map((text) => text.text)).toEqual(["Living room", "Kitchen", "Bedroom"]);
    expect(parseTimeline(JSON.parse(JSON.stringify(timeline)))).toEqual(timeline);
  });

  it("cuts on the beat when music with a tempo is given", () => {
    const timeline = buildTourReel({ shots, plan, music: { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 100, beatOffsetMs: 0 } })!;
    expect(clipStartsMs(timeline).slice(1).every((cut) => cut % 600 === 0)).toBe(true);
  });

  it("needs at least two usable shots", () => {
    expect(buildTourReel({ shots: shots.slice(0, 2), plan })).toBeNull();
  });
});

describe("listing details", () => {
  const details = listingDetailsSchema.parse({ price: "¥48,000,000", beds: "3", baths: "2", area: "92 m²", address: "Kanda, Chiyoda", contact: "@demo_realty" });

  it("knows when a card has anything to show", () => {
    expect(hasDetails(details)).toBe(true);
    expect(hasDetails(listingDetailsSchema.parse({}))).toBe(false);
    expect(hasDetails(null)).toBe(false);
  });

  it("lists only the facts that were filled in", () => {
    expect(detailFacts(details)).toEqual(["3 bed", "2 bath", "92 m²"]);
    expect(detailFacts(listingDetailsSchema.parse({ beds: "1" }))).toEqual(["1 bed"]);
  });

  it("drafts a caption", () => {
    expect(captionFromDetails(details)).toBe(
      "¥48,000,000 · Kanda, Chiyoda\n\n3 bed · 2 bath · 92 m²\n\nViewings: @demo_realty\n\n#justlisted #housetour #realestate #newlisting",
    );
  });
});
