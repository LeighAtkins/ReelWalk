import { describe, expect, it } from "vitest";
import { applyCommand, COMMAND_TYPES, parseSurfaceRegions, parseTimeline, placementProblem, SURFACE_REGIONS_SCHEMA, surfacePatch, timelineSchema, type Command, type TitleOnSurface } from "../src";

const reel = () => parseTimeline({
  version: 1,
  clips: [
    { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 6000 },
    { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
  ],
  texts: [{ id: "t", text: "THE LODGE", startMs: 500, endMs: 2000, style: "box", color: "#ffffff", size: 1.4, bars: [[0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2]], occluders: [{ x: 0.3, y: 0.3 }] }],
  music: null,
});
const ctx = { generation: 0, sourceDurationsMs: { v1: 20000, v2: 20000 } };
const placement: TitleOnSurface = { corners: [0.2, 0.3, 0.8, 0.3, 0.8, 0.4, 0.2, 0.4], ink: { color: "#f4eee2", shadow: "soft" } };
const place = (patch: Partial<Extract<Command, { type: "placeOnSurface" }>> = {}): Extract<Command, { type: "placeOnSurface" }> => ({ type: "placeOnSurface", textId: "t", clipId: "a", atMs: 600, placement, ...patch });

describe("placeOnSurface (pure command)", () => {
  it("is in the registry the HTTP route accepts", () => {
    expect(COMMAND_TYPES).toContain("placeOnSurface");
  });

  it("lays the title on the surface in the house serif, with no box, the surface blend and the chosen ink", () => {
    const result = applyCommand(reel(), place(), ctx);
    expect(result.rejected).toBeUndefined();
    const text = result.timeline.texts[0];
    expect(text.surface).toEqual(placement.corners);
    expect(text.blend).toBe("surface");
    expect(text.style).toBe("elegant");
    expect(text.style).not.toBe("box");
    expect(text.font).toBe("serif");
    expect(text.color).toBe("#f4eee2");
    expect(text.shadow).toBe("soft");
    expect(text.size).toBe(1);
    // The title lives where its surface is, and what belonged to the old placement is gone.
    expect(text.x).toBeCloseTo(0.5, 3); expect(text.y).toBeCloseTo(0.35, 3);
    expect(text.bars).toBeUndefined(); expect(text.occluders).toBeUndefined();
    expect(result.changes).toEqual([{ kind: "text", id: "t" }]);
    expect(timelineSchema.safeParse(result.timeline).success).toBe(true);
  });

  it("writes the track and the shot's span when the surface was followed", () => {
    const pinned = { path: [{ t: 0, x: 0, y: 0, q: placement.corners }, { t: 1, x: 0.02, y: 0, q: placement.corners.map((v, i) => (i % 2 === 0 ? v + 0.02 : v)) }], pin: { assetId: "v1", fromMs: 0, toMs: 6000, quad: placement.corners } };
    const result = applyCommand(reel(), place({ placement: { ...placement, pinned, timing: { startMs: 0, endMs: 6000 } } }), ctx);
    expect(result.rejected).toBeUndefined();
    const text = result.timeline.texts[0];
    expect(text.path).toHaveLength(2); expect(text.pin?.assetId).toBe("v1");
    expect(text.startMs).toBe(0); expect(text.endMs).toBe(6000);
  });

  it("is one step: a batch with it undoes as one", () => {
    const result = applyCommand(reel(), { type: "batch", commands: [place(), { type: "updateText", textId: "t", patch: { animation: "fade" } }] }, ctx);
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.texts[0].animation).toBe("fade");
    expect(result.timeline.texts[0].surface).toEqual(placement.corners);
  });

  it("refuses, with an explanation, a command that has no surface yet (the pure command cannot look at a picture)", () => {
    const result = applyCommand(reel(), place({ placement: undefined }), ctx);
    expect(result.rejected).toMatch(/POST \/api\/reels\/:id\/commands/);
    expect(result.timeline).toEqual(reel());
  });

  it("refuses a text that is not there and corners that make no sense", () => {
    expect(applyCommand(reel(), place({ textId: "nope" }), ctx).rejected).toMatch(/no text called nope/);
    expect(applyCommand(reel(), place({ placement: { corners: [0, 0, 1, 1] } }), ctx).rejected).toMatch(/eight numbers/);
    expect(applyCommand(reel(), place({ placement: { corners: [0.1, 0.1, 0.9, 0.1, 0.9, 9, 0.1, 0.9] } }), ctx).rejected).toMatch(/between -0.5 and 1.5/);
    expect(applyCommand(reel(), place({ placement: { corners: placement.corners, ink: { color: "red", shadow: "soft" } } }), ctx).rejected).toMatch(/#rrggbb/);
    expect(applyCommand(reel(), place({ placement: { corners: placement.corners, ink: { color: "#ffffff", shadow: "loud" as "soft" } } }), ctx).rejected).toMatch(/soft/);
  });

  it("surfacePatch never sets a background style and keeps the ink optional", () => {
    const patch = surfacePatch({ corners: placement.corners });
    expect(patch.style).toBe("elegant");
    expect(patch).not.toHaveProperty("color");
    expect(placementProblem({ corners: placement.corners })).toBeNull();
    expect(placementProblem(null)).toMatch(/object/);
  });
});

describe("parseSurfaceRegions", () => {
  it("cleans what the model said: orders the corners, clamps, trims, keeps kinds it knows", () => {
    const hints = parseSurfaceRegions({
      regions: [
        // Corners given from the bottom-left round: put back in tl, tr, br, bl order.
        { kind: "wall", corners: [0.1, 0.8, 0.1, 0.2, 0.9, 0.25, 0.9, 0.75], confidence: 0.9, clear: true, note: "  cream wall behind the sofa  " },
        { kind: "sky", corners: [-0.5, 0, 2, 0, 2, 0.2, -0.5, 0.2], confidence: 7, clear: false, note: "" },
      ],
      horizon: 0.41,
    });
    expect(hints.horizonY).toBe(0.41);
    expect(hints.regions).toHaveLength(2);
    expect(hints.regions![0].quad.slice(0, 2)).toEqual([0.1, 0.2]); // top-left first
    expect(hints.regions![0].quad.slice(4, 6)).toEqual([0.9, 0.75]); // bottom-right third
    expect(hints.regions![0].note).toBe("cream wall behind the sofa");
    expect(hints.regions![1].quad.every((v) => v >= -0.05 && v <= 1.05)).toBe(true);
    expect(hints.regions![1].confidence).toBe(1);
    expect(hints.regions![1].clear).toBe(false);
  });

  it("drops what cannot be used and never throws", () => {
    expect(parseSurfaceRegions(null)).toEqual({ regions: [], horizonY: null });
    expect(parseSurfaceRegions("nonsense")).toEqual({ regions: [], horizonY: null });
    const hints = parseSurfaceRegions({ regions: [{ kind: "lava", corners: [0, 0, 1, 0, 1, 1, 0, 1] }, { kind: "wall", corners: [0, 0, 1] }, { kind: "wall", corners: [0, 0, 1, 0, 1, NaN, 0, 1] }, 7, null], horizon: "high" });
    expect(hints.regions).toEqual([]);
    expect(hints.horizonY).toBeNull();
  });

  it("keeps at most six, and asks for strict structured output the providers accept", () => {
    const many = Array.from({ length: 10 }, () => ({ kind: "wall", corners: [0.1, 0.1, 0.9, 0.1, 0.9, 0.5, 0.1, 0.5], confidence: 0.5, clear: true, note: "x" }));
    expect(parseSurfaceRegions({ regions: many, horizon: null }).regions).toHaveLength(6);
    expect(SURFACE_REGIONS_SCHEMA.additionalProperties).toBe(false);
    expect(SURFACE_REGIONS_SCHEMA.required).toEqual(["regions", "horizon"]);
    expect(SURFACE_REGIONS_SCHEMA.properties.regions.items.required).toEqual(["kind", "corners", "confidence", "clear", "note"]);
  });
});
