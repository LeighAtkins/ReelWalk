import { describe, expect, it } from "vitest";
import { accentEnvelope, applyCommand, maxTextSize, parseTimeline, portalFootageBox, referencedAssetIds, textSchema, TEXT_SIZE_MAX, type Accent } from "../src";

const clip = { id: "c1", assetId: "take", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 };
const portal = { id: "p1", kind: "portal", startMs: 1000, endMs: 3000, x: 0.5, y: 0.2, width: 0.4, height: 0.3, wall: { kind: "image", assetId: "moss" }, person: { assetId: "take" } };
const flare = { id: "f1", kind: "flare", startMs: 1000, endMs: 3000, x: 0.7, y: 0.4 };
const timeline = () => parseTimeline({ version: 1, texts: [], music: null, clips: [clip] });

describe("setAccents", () => {
  it("puts accents on a reel and fills their defaults", () => {
    const { timeline: next, rejected } = applyCommand(timeline(), { type: "setAccents", accents: [portal, flare] as never }, { generation: 0 });
    expect(rejected).toBeUndefined();
    const saved = next.accents as Accent[];
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ kind: "portal", yaw: 0, followCamera: true, edgeColor: "#ffffff", person: { sourceStartMs: 0, zoom: 1 } });
    expect(saved[1]).toMatchObject({ kind: "flare", size: 0.35, intensity: 0.8 });
  });

  it("takes them off with null", () => {
    const on = applyCommand(timeline(), { type: "setAccents", accents: [flare] as never }, { generation: 0 }).timeline;
    expect(applyCommand(on, { type: "setAccents", accents: null }, { generation: 0 }).timeline.accents).toBeUndefined();
  });

  it("refuses accents past the reel's end, shared ids and no time on screen, saving nothing", () => {
    const late = applyCommand(timeline(), { type: "setAccents", accents: [{ ...flare, endMs: 9000 }] as never }, { generation: 0 });
    expect(late.rejected).toMatch(/9000 ms/);
    expect(applyCommand(timeline(), { type: "setAccents", accents: [flare, flare] as never }, { generation: 0 }).rejected).toMatch(/own id/);
    expect(applyCommand(timeline(), { type: "setAccents", accents: [{ ...flare, endMs: 1000 }] as never }, { generation: 0 }).rejected).toMatch(/positive time/);
  });

  it("round-trips through a saved timeline, and an old reel has none", () => {
    expect(timeline().accents).toBeUndefined();
    const on = applyCommand(timeline(), { type: "setAccents", accents: [portal] as never }, { generation: 0 }).timeline;
    expect(parseTimeline(JSON.parse(JSON.stringify(on))).accents).toEqual(on.accents);
  });

  it("counts a portal's pictures as the reel's assets", () => {
    const on = applyCommand(timeline(), { type: "setAccents", accents: [{ ...portal, person: { assetId: "other" } }] as never }, { generation: 0 }).timeline;
    expect(referencedAssetIds(on).sort()).toEqual(["moss", "other", "take"]);
  });
});

describe("accentEnvelope", () => {
  const accent = { kind: "portal" as const, startMs: 1000, endMs: 3000 };
  it("is hidden outside its time, and starts small and clear", () => {
    expect(accentEnvelope(accent, 999).opacity).toBe(0);
    expect(accentEnvelope(accent, 3000).opacity).toBe(0);
    expect(accentEnvelope(accent, 1000)).toEqual({ opacity: 0, scale: 0.86 });
  });
  it("rests at full size, then fades out", () => {
    expect(accentEnvelope(accent, 2000)).toEqual({ opacity: 1, scale: 1 });
    expect(accentEnvelope(accent, 2920).opacity).toBeCloseTo(0.5, 2);
    expect(accentEnvelope(accent, 2920).scale).toBe(1);
  });
  it("plays faster on a short accent, so it still rests", () => {
    expect(accentEnvelope({ ...accent, endMs: 1300 }, 1150)).toEqual({ opacity: 1, scale: 1 });
  });
  it("never resizes a flare", () => {
    expect(accentEnvelope({ ...accent, kind: "flare" }, 1000).scale).toBe(1);
  });
});

describe("portalFootageBox", () => {
  const frame = { width: 1080, height: 1920 };
  it("fills the card with the frame when there is no zoom and the focus is centred", () => {
    const box = portalFootageBox({ zoom: 1, focusX: 0.5, focusY: 0.5 }, { width: 540, height: 960 }, frame);
    expect(box).toEqual({ left: 0, top: 0, scale: 0.5 });
  });
  it("lands the focus on the card's centre, zoomed", () => {
    const card = { width: 300, height: 600 };
    const { left, top, scale } = portalFootageBox({ zoom: 1.5, focusX: 0.44, focusY: 0.69 }, card, frame);
    expect(scale).toBeCloseTo((600 / 1920) * 1.5, 6);
    expect(left + 0.44 * 1080 * scale).toBeCloseTo(150, 6);
    expect(top + 0.69 * 1920 * scale).toBeCloseTo(300, 6);
  });
});

describe("display titles", () => {
  const base = { id: "t", text: "houses", startMs: 0, endMs: 1000, style: "headline" };
  it("may be far larger than an ordinary title", () => {
    expect(maxTextSize({ display: true })).toBeGreaterThan(TEXT_SIZE_MAX);
    expect(textSchema.safeParse({ ...base, size: 4, display: true }).success).toBe(true);
    expect(textSchema.safeParse({ ...base, size: 4 }).success).toBe(false);
  });
  it("keep their size when added by command; an ordinary title is still limited", () => {
    const add = (extra: object) => applyCommand(timeline(), { type: "addText", text: { ...base, size: 4, x: 0.5, y: 0.3, ...extra } as never }, { generation: 0 }).timeline.texts[0].size;
    expect(add({ display: true })).toBe(4);
    expect(add({})).toBe(TEXT_SIZE_MAX);
  });
  it("carry a glow, checked", () => {
    const parsed = textSchema.parse({ ...base, glow: { color: "#ff2fd0" } });
    expect(parsed.glow).toEqual({ color: "#ff2fd0", radius: 0.12, strength: 0.8 });
    expect(textSchema.safeParse({ ...base, glow: { color: "pink" } }).success).toBe(false);
    expect(textSchema.safeParse({ ...base, glow: { color: "#ff2fd0", radius: 2 } }).success).toBe(false);
  });
});
