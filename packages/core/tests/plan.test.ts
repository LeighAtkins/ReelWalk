import { describe, expect, it } from "vitest";
import {
  addClips,
  addRoomLabels,
  addText,
  emptyTimeline,
  hasRoomLabels,
  listingDetailsSchema,
  moveClip,
  normalizePlan,
  parseTimeline,
  pointInPolygon,
  removeRoomLabels,
  roomIndexAt,
  roomTitle,
  setDetails,
  setPlan,
  type Clip,
} from "../src";

const square = (x: number, y: number, size: number): [number, number][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

function clip(id: string, room: string | null): Clip {
  return {
    id,
    assetId: id,
    kind: "IMAGE",
    sourceStartMs: 0,
    sourceEndMs: 4000,
    speed: 1,
    volume: 1,
    fit: "cover",
    filter: "none",
    motion: "none",
    transitionIn: "cut",
    pano: null,
    spot: room ? { x: 0.5, y: 0.5, heading: 0 } : null,
    room,
  };
}

describe("plan geometry", () => {
  it("normalises any units into a 0..1 box and keeps the shape's proportions", () => {
    const { plan, toPlan } = normalizePlan([square(-4, 2, 2), square(-2, 2, 6)]);
    expect(plan.aspect).toBeCloseTo(8 / 6);
    expect(plan.rooms[0].points[0]).toEqual([0, 0]);
    expect(toPlan(4, 8)).toEqual([1, 1]);
    expect(toPlan(0, 5)).toEqual([0.5, 0.5]);
  });

  it("finds the room a shot was taken in, preferring the smaller of nested rooms", () => {
    const { plan } = normalizePlan([square(0, 0, 10), square(1, 1, 2)]);
    expect(roomIndexAt(plan, { x: 0.2, y: 0.2 })).toBe(1);
    expect(roomIndexAt(plan, { x: 0.8, y: 0.8 })).toBe(0);
    expect(pointInPolygon(2, 2, square(0, 0, 1))).toBe(false);
  });

  it("titles room names", () => {
    expect(roomTitle("living room")).toBe("Living room");
    expect(roomTitle("")).toBe("");
  });
});

describe("room labels", () => {
  const timeline = addClips(emptyTimeline(), [clip("a", "kitchen"), clip("b", "kitchen"), clip("c", null), clip("d", "bedroom")]);

  it("labels each room once, spanning consecutive shots of it", () => {
    const labelled = addRoomLabels(timeline);
    expect(labelled.texts.map((text) => [text.text, text.startMs, text.endMs])).toEqual([
      ["Kitchen", 200, 8000],
      ["Bedroom", 12_200, 16_000],
    ]);
    expect(hasRoomLabels(labelled)).toBe(true);
  });

  it("can be run again after reordering without duplicating, and keeps other text", () => {
    const withTitle = addText(addRoomLabels(timeline), { id: "title", text: "Just listed", startMs: 0, x: 0.5, y: 0.4, style: "plain", color: "#ffffff", size: 1 });
    const again = addRoomLabels(moveClip(withTitle, "d", 0));
    expect(again.texts.map((text) => text.text).sort()).toEqual(["Bedroom", "Just listed", "Kitchen"]);
    expect(removeRoomLabels(again).texts.map((text) => text.text)).toEqual(["Just listed"]);
  });
});

describe("room labels and the details card", () => {
  it("ends the last label before the card appears", () => {
    const base = addClips(emptyTimeline(), [clip("a", "kitchen"), clip("d", "bedroom")]);
    const withCard = setDetails(base, listingDetailsSchema.parse({ price: "¥48,000,000", placement: "end" }));
    const labels = addRoomLabels(withCard).texts;
    // 8 s reel: the card holds the last 3.2 s (40% of the reel), so "Bedroom" ends at 4.8 s.
    expect(labels.map((text) => [text.text, text.endMs])).toEqual([
      ["Kitchen", 4000],
      ["Bedroom", 4800],
    ]);
  });
});

describe("plan on a timeline", () => {
  it("round-trips, and old timelines without a plan still parse", () => {
    const { plan } = normalizePlan([square(0, 0, 4)], [[[0, 1], [0, 2]]]);
    const timeline = setPlan(addClips(emptyTimeline(), [clip("a", "kitchen")]), { geometry: plan, corner: "top-right", visible: true });
    expect(parseTimeline(JSON.parse(JSON.stringify(timeline)))).toEqual(timeline);
    expect(parseTimeline({ version: 1, clips: [], texts: [], music: null }).plan).toBeNull();
  });
});
