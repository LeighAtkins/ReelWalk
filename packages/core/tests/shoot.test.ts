import { describe, expect, it } from "vitest";
import {
  MAX_SHOTS,
  SHOT_LIST_JSON_SCHEMA,
  SHOT_MOVES,
  describeShootRequest,
  matchUploadsToShots,
  roomsFromListing,
  shootRequestSchema,
  shotListSchema,
  standardShotList,
} from "../src/shoot";

const shot = (room: string, extra: Record<string, unknown> = {}) => ({ room, title: room, how: `Film the ${room}.`, move: "pan-left", holdS: 3, ...extra });

describe("shot list schema", () => {
  it("accepts a model answer and normalises it", () => {
    const list = shotListSchema.parse({ note: "Morning light is best.", shots: [shot("Kitchen", { holdS: 2.6 }), shot("view", { holdS: 40, move: "static" })] });
    expect(list.shots[0]).toMatchObject({ room: "kitchen", holdS: 3 });
    // Holds are kept to 1–8 s whatever the model says.
    expect(list.shots[1].holdS).toBe(8);
  });

  it("caps the list at twelve shots", () => {
    const list = shotListSchema.parse({ note: "", shots: Array.from({ length: 15 }, (_, i) => shot(`room ${i}`)) });
    expect(list.shots).toHaveLength(MAX_SHOTS);
    expect(list.shots.at(-1)!.room).toBe("room 11");
  });

  it("rejects an empty list, unknown moves, missing fields and overlong text", () => {
    expect(shotListSchema.safeParse({ note: "", shots: [] }).success).toBe(false);
    expect(shotListSchema.safeParse({ note: "", shots: [shot("kitchen", { move: "zoom" })] }).success).toBe(false);
    expect(shotListSchema.safeParse({ note: "", shots: [{ room: "kitchen", title: "Kitchen", move: "static", holdS: 2 }] }).success).toBe(false);
    expect(shotListSchema.safeParse({ note: "", shots: [shot("kitchen", { how: "x".repeat(221) })] }).success).toBe(false);
    expect(shotListSchema.safeParse({ note: "", shots: [shot("kitchen", { holdS: Number.NaN })] }).success).toBe(false);
  });

  it("the strict JSON schema requires every field and allows no others", () => {
    const item = SHOT_LIST_JSON_SCHEMA.properties.shots.items;
    expect(SHOT_LIST_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
    expect([...SHOT_LIST_JSON_SCHEMA.required].sort()).toEqual(Object.keys(SHOT_LIST_JSON_SCHEMA.properties).sort());
    expect(item.properties.move.enum).toEqual([...SHOT_MOVES]);
  });
});

describe("shoot request", () => {
  it("needs rooms or a listing", () => {
    expect(shootRequestSchema.safeParse({ propertyType: "house", rooms: [], listing: "" }).success).toBe(false);
    expect(shootRequestSchema.safeParse({ propertyType: "house", rooms: ["Kitchen"] }).data?.rooms).toEqual(["kitchen"]);
    expect(shootRequestSchema.safeParse({ listing: "Sunny three bedroom home with a pool and a big kitchen." }).success).toBe(true);
  });

  it("describes the request for the model", () => {
    const text = describeShootRequest(shootRequestSchema.parse({ propertyType: "villa", rooms: ["kitchen", "pool"], listing: "Sea views from every room." }));
    expect(text).toContain("Property: villa.");
    expect(text).toContain("kitchen, pool");
    expect(text).toContain("Sea views");
  });
});

describe("standard shot list", () => {
  it("orders the rooms as a walk-through, arrival and front door first, and says how to film each", () => {
    const list = standardShotList(shootRequestSchema.parse({ propertyType: "house", rooms: ["pool", "kitchen", "bedroom", "living room", "bedroom"] }));
    expect(list.shots.map((s) => s.room)).toEqual(["exterior", "front door", "living room", "kitchen", "bedroom", "bedroom", "pool"]);
    expect(list.shots[1].how).toMatch(/front door slowly, phone at chest height, and hold 3 s/);
    expect(list.shots[3]).toMatchObject({ move: "pan-left" });
    expect(list.shots.map((s) => s.title)).toContain("Bedroom 2");
    // Every shot passes the same validation as a model's answer.
    expect(shotListSchema.parse(list).shots).toHaveLength(7);
  });

  it("an apartment has no exterior shot; unknown rooms get a generic way to film them", () => {
    const list = standardShotList(shootRequestSchema.parse({ propertyType: "apartment", rooms: ["wine cellar"] }));
    expect(list.shots.map((s) => s.room)).toEqual(["front door", "wine cellar"]);
    expect(list.shots[1].how).toContain("wine cellar");
  });

  it("keeps at most twelve shots and keeps the view as the ending", () => {
    const rooms = ["view", "kitchen", "bedroom", "bedroom", "bedroom", "bedroom", "bathroom", "bathroom", "office", "garage", "laundry", "patio", "garden", "pool"];
    const list = standardShotList(shootRequestSchema.parse({ rooms }));
    expect(list.shots).toHaveLength(MAX_SHOTS);
    expect(list.shots[0].room).toBe("exterior");
    expect(list.shots.at(-1)!.room).toBe("view");
  });

  it("reads the rooms from a listing when none were picked, and is deterministic", () => {
    const listing = "Renovated family home: open-plan kitchen with island, master suite with ensuite, two further bedrooms, a sunny deck and a heated pool.";
    expect(roomsFromListing(listing)).toEqual(["kitchen", "primary bedroom", "bedroom", "bathroom", "patio", "pool"]);
    const request = shootRequestSchema.parse({ listing });
    expect(standardShotList(request)).toEqual(standardShotList(request));
  });
});

describe("matching uploads to shots", () => {
  const shots = standardShotList(shootRequestSchema.parse({ propertyType: "apartment", rooms: ["living room", "kitchen", "view"] })).shots;
  // front door, living room, kitchen, view

  it("puts files in capture order and gives each the room of the shot filmed then", () => {
    const files = [
      { name: "IMG_3.mov", lastModified: 3000 },
      { name: "IMG_1.mov", lastModified: 1000 },
      { name: "IMG_2.mov", lastModified: 2000 },
    ];
    expect(matchUploadsToShots(files, shots)).toEqual([
      { file: 1, shot: 0, room: "front door" },
      { file: 2, shot: 1, room: "living room" },
      { file: 0, shot: 2, room: "kitchen" },
    ]);
  });

  it("matches only the ticked shots when some were ticked, and leaves extra files without a room", () => {
    const files = [1, 2, 3].map((n) => ({ name: `IMG_${n}.mov`, lastModified: n * 1000 }));
    expect(matchUploadsToShots(files, shots, [false, true, false, true])).toEqual([
      { file: 0, shot: 1, room: "living room" },
      { file: 1, shot: 3, room: "view" },
      { file: 2, shot: null, room: null },
    ]);
  });

  it("files with the same time fall back to their names", () => {
    const files = [{ name: "b.jpg", lastModified: 5 }, { name: "a.jpg", lastModified: 5 }];
    expect(matchUploadsToShots(files, shots).map((m) => m.file)).toEqual([1, 0]);
  });
});
