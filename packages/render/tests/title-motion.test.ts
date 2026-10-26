import { describe, expect, it } from "vitest";
import { evaluateTitle, parseTimeline, type Measure, type SurfacePlacement } from "@reelwalk/core";
import { textCss } from "../src/reel/look";
import { textExit, titleFont } from "../src/reel/title-motion";

describe("kinetic type keeps the way out (ADR 0061)", () => {
  const fps = 30, duration = 90;
  it("an elegant title revealed word by word keeps its track-in's way out (its last 8 frames, ADR 0082); a named fade its 0.6 s", () => {
    const elegant = { animation: "auto" as const, style: "elegant" as const };
    expect(textExit(elegant, 0, fps, duration).opacity).toBe(1);
    expect(textExit(elegant, 81, fps, duration).opacity).toBe(1);
    expect(textExit(elegant, 86, fps, duration).opacity).toBeGreaterThan(0);
    expect(textExit(elegant, 86, fps, duration).opacity).toBeLessThan(1);
    expect(textExit(elegant, 90, fps, duration).opacity).toBe(0);
    const fade = { animation: "fade" as const, style: "elegant" as const };
    expect(textExit(fade, 71, fps, duration).opacity).toBe(1);
    expect(textExit(fade, 81, fps, duration).opacity).toBeCloseTo(0.5);
    expect(textExit({ animation: "fade", style: "headline" }, 90, fps, duration).opacity).toBe(0);
  });

  it("nothing else has an exit, and the entrance is never applied", () => {
    for (const animation of ["auto", "pop", "rise", "type", "none"] as const) {
      expect(textExit({ animation, style: "headline" }, 0, fps, duration)).toEqual({ scale: 1, opacity: 1, rise: 0, chars: null });
      expect(textExit({ animation, style: "headline" }, 89, fps, duration).opacity).toBe(1);
    }
  });
});

describe("a count-up is measured with the figures it draws (ADR 0061)", () => {
  // A measurer that, like most faces, sets tabular figures wider than proportional ones.
  const measure: Measure = (line, font) => {
    const digits = (line.match(/\d/g) ?? []).length;
    const digit = font.fontVariantNumeric === "tabular-nums" ? 0.62 : 0.5;
    return { width: (line.length - digits) * font.fontSize * 0.55 + digits * font.fontSize * digit, height: font.fontSize * 1.12 };
  };
  const surface = [0.1, 0.2, 0.8, 0.2, 0.8, 0.3, 0.1, 0.3];
  const timeline = parseTimeline({
    version: 1, music: null,
    clips: [{ id: "c", assetId: "a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 }],
    texts: [{ id: "n", text: "$1,111,111", startMs: 0, endMs: 3000, style: "headline", surface, kinetic: { preset: "count" } }],
  });
  const text = timeline.texts[0];
  const css = textCss(text.style, text.color, text.size);
  const fit = (font: ReturnType<typeof titleFont>) => {
    const placement = evaluateTitle({ text, timeline, frame: 10, from: 0, durationInFrames: 90, fps: 30, width: 1080, height: 1920, font, measure }) as SurfacePlacement;
    return { fitScale: placement.fitScale, drawn: measure(text.text, { ...font, fontVariantNumeric: "tabular-nums" }).width * placement.fitScale, room: placement.rect.width };
  };

  it("asks for tabular figures, so the fitted line still fits when drawn tabular", () => {
    const font = titleFont(text, css);
    expect(font.fontVariantNumeric).toBe("tabular-nums");
    const right = fit(font);
    expect(right.drawn).toBeLessThanOrEqual(right.room);
    // Measured proportional (the bug), the same drawn line overflows its surface and is clipped.
    const wrong = fit({ ...font, fontVariantNumeric: undefined });
    expect(wrong.drawn).toBeGreaterThan(wrong.room);
  });

  it("leaves every other title's font as it was", () => {
    const plain = titleFont({ tracking: 0.06 }, css);
    expect(plain).not.toHaveProperty("fontVariantNumeric");
    expect(plain).toEqual({ fontFamily: String(css.fontFamily), fontWeight: css.fontWeight, fontSize: css.fontSize, letterSpacing: 0.06, fontStretch: css.fontStretch ? String(css.fontStretch) : undefined });
  });
});
