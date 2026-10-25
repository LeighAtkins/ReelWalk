import { describe, expect, it } from "vitest";
import { BRAND_FONTS, BRAND_FONT_IDS, BRAND_FONT_NOTICE, brandFontHasWeight, textTreatmentSchema } from "../src/brand-fonts";
import { brandKitSchema, describeBrandKit, readBrandKit, resolveTextStyle } from "../src/brand-kit";
import { BUNDLED_BRAND_KITS, LAST_MILE_KIT } from "../src/brand-kits";
import { applyCommand, COMMAND_TYPES, type Command, type CommandContext } from "../src/commands";
import { parseTimeline, textSchema, timelineSchema, TEXT_SIZE_MAX, type Timeline } from "../src/timeline";

// Brand kits (ADR 0078): data on the workspace, applied to titles by name, copied onto the text so a saved reel needs nothing else.

const reel = (): Timeline =>
  parseTimeline({
    version: 1,
    clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 6000 }],
    texts: [
      { id: "title", text: "LAST MILE", startMs: 0, endMs: 3000, style: "elegant", color: "#ffffff", size: 1 },
      { id: "line", text: "Day three.", startMs: 3000, endMs: 5500 },
    ],
    music: null,
  });
const ctx: CommandContext = { generation: 0, sourceDurationsMs: { v1: 20000 }, brandKit: LAST_MILE_KIT };

describe("the font registry", () => {
  it("knows which weights each bundled font really ships", () => {
    expect(brandFontHasWeight("big-shoulders-display", 900)).toBe(true);
    expect(brandFontHasWeight("big-shoulders-display", 450)).toBe(true);
    expect(brandFontHasWeight("big-shoulders-display", 1000)).toBe(false);
    expect(brandFontHasWeight("atkinson-hyperlegible", 700)).toBe(true);
    expect(brandFontHasWeight("atkinson-hyperlegible", 900)).toBe(false);
    expect(brandFontHasWeight("chakra-petch", 600)).toBe(true);
    expect(brandFontHasWeight("chakra-petch", 400)).toBe(false);
  });
  it("credits every family under the OFL", () => {
    for (const id of BRAND_FONT_IDS) expect(BRAND_FONT_NOTICE).toContain(BRAND_FONTS[id].label);
    expect(BRAND_FONT_NOTICE.split("\n").every((line) => /SIL Open Font License 1\.1/.test(line))).toBe(true);
  });
});

describe("the treatment a text stores", () => {
  const ok = { style: "lastmile-title", font: "big-shoulders-display", weight: 900, slant: 10, shadow: { dx: 0.048, dy: 0.04, color: "#ff2bd6" } };
  it("accepts a hard shadow, a slant and a plate with an edge", () => {
    expect(textTreatmentSchema.safeParse(ok).success).toBe(true);
    expect(textTreatmentSchema.safeParse({ style: "x", font: "atkinson-hyperlegible", weight: 700, plate: { color: "#07080e", opacity: 0.85, edge: { width: 0.05, color: "#ff2bd6" } } }).success).toBe(true);
  });
  it("refuses a font the composition does not bundle, a weight it does not ship and a colour that is not hex", () => {
    expect(textTreatmentSchema.safeParse({ ...ok, font: "comic-sans" }).success).toBe(false);
    expect(textTreatmentSchema.safeParse({ ...ok, font: "chakra-petch", weight: 900 }).success).toBe(false);
    expect(textTreatmentSchema.safeParse({ ...ok, shadow: { dx: 0.05, dy: 0.05, color: "magenta" } }).success).toBe(false);
    expect(textTreatmentSchema.safeParse({ ...ok, slant: 45 }).success).toBe(false);
  });
});

describe("the Last Mile kit", () => {
  it("is valid data and is the only bundled kit", () => {
    expect(brandKitSchema.safeParse(LAST_MILE_KIT).success).toBe(true);
    expect(Object.keys(BUNDLED_BRAND_KITS)).toEqual(["last-mile"]);
  });
  it("has the styles the brief names", () => {
    const names = LAST_MILE_KIT.styles.map((style) => style.name);
    expect(names).toEqual(expect.arrayContaining(["lastmile-title", "lastmile-caption", "lastmile-caption-cyan", "lastmile-punchline", "lastmile-label"]));
  });
  it("uses only colours from its own palette", () => {
    const palette = new Set(LAST_MILE_KIT.palette.map((entry) => entry.hex.toLowerCase()));
    for (const style of LAST_MILE_KIT.styles) {
      const used = [style.color, style.look.shadow?.color, style.look.plate?.color, style.look.plate?.edge?.color].filter((color): color is string => Boolean(color));
      for (const color of used) expect(palette.has(color.toLowerCase()), `${style.name} ${color}`).toBe(true);
    }
  });
  it("draws the title card as specified: paper letters, a magenta hard shadow of 12 x 10 px at 250 px, weight 900, leaning forward", () => {
    const title = LAST_MILE_KIT.styles.find((style) => style.name === "lastmile-title")!;
    expect(title.color).toBe("#f3f1ff");
    expect(title.look.weight).toBe(900);
    expect(title.look.slant).toBeGreaterThan(0);
    expect(title.look.shadow).toEqual({ dx: 0.048, dy: 0.04, color: "#ff2bd6" });
    expect(250 * title.look.shadow!.dx).toBeCloseTo(12, 5);
    expect(250 * title.look.shadow!.dy).toBeCloseTo(10, 5);
  });
  it("sets captions on an 85% ink plate with a 3 px magenta edge (cyan in the alternate)", () => {
    for (const [name, edge] of [["lastmile-caption", "#ff2bd6"], ["lastmile-caption-cyan", "#22e6ff"]] as const) {
      const style = LAST_MILE_KIT.styles.find((entry) => entry.name === name)!;
      expect(style.look.plate).toMatchObject({ color: "#07080e", opacity: 0.85, edge: { color: edge } });
      expect(style.look.font).toBe("atkinson-hyperlegible");
      // 3 px at the caption's own font size (76 px base x size).
      expect(style.look.plate!.edge!.width * 76 * style.size).toBeCloseTo(3, 0);
    }
  });
  it("keeps every title size inside what a text may be", () => {
    for (const style of LAST_MILE_KIT.styles) expect(style.size).toBeLessThanOrEqual(TEXT_SIZE_MAX);
  });
});

describe("validating a kit", () => {
  const kit = JSON.parse(JSON.stringify(LAST_MILE_KIT));
  it("refuses a style that uses a font the kit does not list", () => {
    const bad = { ...kit, fonts: ["chakra-petch"] };
    expect(brandKitSchema.safeParse(bad).success).toBe(false);
  });
  it("refuses two styles with one name, and a bad name", () => {
    expect(brandKitSchema.safeParse({ ...kit, styles: [kit.styles[0], kit.styles[0]] }).success).toBe(false);
    expect(brandKitSchema.safeParse({ ...kit, styles: [{ ...kit.styles[0], name: "Last Mile Title" }] }).success).toBe(false);
  });
  it("reads a stored kit, and a broken one as no kit rather than throwing", () => {
    expect(readBrandKit(kit)?.id).toBe("last-mile");
    expect(readBrandKit(null)).toBeNull();
    expect(readBrandKit({ id: "x" })).toBeNull();
    expect(readBrandKit("nope")).toBeNull();
  });
});

describe("resolving a style", () => {
  it("writes the kit's colour, size, tracking and look, in the plain text style", () => {
    const resolved = resolveTextStyle(LAST_MILE_KIT, "lastmile-punchline");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.patch).toMatchObject({ style: "plain", color: "#e8ff3a", size: 2.1, brand: { style: "lastmile-punchline", font: "big-shoulders-display", weight: 900 } });
  });
  it("answers an unknown style with the names the kit has", () => {
    const resolved = resolveTextStyle(LAST_MILE_KIT, "lastmile-bold");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toMatch(/lastmile-title, .*lastmile-caption/);
  });
  it("describes the kit for an agent: every style with its look, and the palette", () => {
    const described = describeBrandKit(LAST_MILE_KIT);
    expect(described.styles.map((style) => style.name)).toEqual(LAST_MILE_KIT.styles.map((style) => style.name));
    expect(described.palette.find((entry) => entry.id === "magenta")?.hex).toBe("#ff2bd6");
    expect(described.styles[0].look.font).toBe("big-shoulders-display");
  });
});

describe("the applyTextStyle command", () => {
  it("is in the registry, so the HTTP route and the MCP tool accept it", () => {
    expect(COMMAND_TYPES).toContain("applyTextStyle");
  });

  it("applies a kit style to a title and nothing else", () => {
    const before = reel();
    const result = applyCommand(before, { type: "applyTextStyle", textId: "title", style: "lastmile-title" }, ctx);
    expect(result.rejected).toBeUndefined();
    expect(result.changes).toEqual([{ kind: "text", id: "title" }]);
    const title = result.timeline.texts.find((text) => text.id === "title")!;
    expect(title).toMatchObject({ style: "plain", color: "#f3f1ff", size: 2.5, tracking: 0.02, brand: { style: "lastmile-title", weight: 900, shadow: { color: "#ff2bd6" } } });
    expect(result.timeline.texts.find((text) => text.id === "line")).toEqual(before.texts.find((text) => text.id === "line"));
    expect(result.timeline.clips).toEqual(before.clips);
    // Position and timing are the title's own.
    expect(title).toMatchObject({ x: 0.5, y: 0.4, startMs: 0, endMs: 3000 });
  });

  it("leaves the result a valid timeline", () => {
    const result = applyCommand(reel(), { type: "applyTextStyle", textId: "line", style: "lastmile-caption" }, ctx);
    expect(timelineSchema.safeParse(result.timeline).success).toBe(true);
  });

  it("is refused without a kit, with an unknown style or for a text that is not there, and changes nothing", () => {
    const before = reel();
    const cases: [Command, CommandContext, RegExp][] = [
      [{ type: "applyTextStyle", textId: "title", style: "lastmile-title" }, { ...ctx, brandKit: null }, /no brand kit/],
      [{ type: "applyTextStyle", textId: "title", style: "lastmile-bold" }, ctx, /no style called lastmile-bold.*lastmile-title/],
      [{ type: "applyTextStyle", textId: "ghost", style: "lastmile-title" }, ctx, /no text called ghost/],
    ];
    for (const [command, context, message] of cases) {
      const result = applyCommand(before, command, context);
      expect(result.rejected).toMatch(message);
      expect(result.timeline).toBe(before);
    }
  });

  it("takes the style off with style null, keeping the colour and size it set", () => {
    const styled = applyCommand(reel(), { type: "applyTextStyle", textId: "title", style: "lastmile-title" }, ctx).timeline;
    const off = applyCommand(styled, { type: "applyTextStyle", textId: "title", style: null }, { ...ctx, brandKit: null });
    expect(off.rejected).toBeUndefined();
    const title = off.timeline.texts.find((text) => text.id === "title")!;
    expect(title.brand).toBeUndefined();
    expect(title.color).toBe("#f3f1ff");
  });

  it("is one step in a batch with other commands, and a bad style fails the whole batch", () => {
    const good = applyCommand(reel(), { type: "batch", commands: [{ type: "applyTextStyle", textId: "title", style: "lastmile-title" }, { type: "applyTextStyle", textId: "line", style: "lastmile-caption" }] }, ctx);
    expect(good.changes.map((change) => (change.kind === "text" ? change.id : "")).sort()).toEqual(["line", "title"]);
    const bad = applyCommand(reel(), { type: "batch", commands: [{ type: "applyTextStyle", textId: "title", style: "lastmile-title" }, { type: "applyTextStyle", textId: "line", style: "nope" }] }, ctx);
    expect(bad.rejected).toBeDefined();
    expect(bad.changes).toEqual([]);
  });

  it("is a no-op, and no history step, when the text already has the style", () => {
    const styled = applyCommand(reel(), { type: "applyTextStyle", textId: "title", style: "lastmile-title" }, ctx).timeline;
    const again = applyCommand(styled, { type: "applyTextStyle", textId: "title", style: "lastmile-title" }, ctx);
    expect(again.changes).toEqual([]);
  });
});

describe("reels saved before brand kits", () => {
  it("parse to exactly what they were, with no brand on any text", () => {
    const saved = { version: 1, clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 6000 }], texts: [{ id: "t", text: "Hello", startMs: 0, endMs: 2000, style: "elegant", font: "serif", shadow: "soft", tracking: 0.1 }], music: null };
    const parsed = parseTimeline(saved);
    expect(parsed.texts[0].brand).toBeUndefined();
    expect("brand" in parsed.texts[0]).toBe(false);
    expect(JSON.parse(JSON.stringify(parseTimeline(JSON.parse(JSON.stringify(parsed)))))).toEqual(JSON.parse(JSON.stringify(parsed)));
    expect(textSchema.parse(parsed.texts[0])).toEqual(parsed.texts[0]);
  });
  it("round-trip a branded text through save and load unchanged", () => {
    const styled = applyCommand(reel(), { type: "applyTextStyle", textId: "title", style: "lastmile-caption" }, ctx).timeline;
    const loaded = parseTimeline(JSON.parse(JSON.stringify(styled)));
    expect(loaded.texts[0].brand).toEqual(styled.texts[0].brand);
  });
});
