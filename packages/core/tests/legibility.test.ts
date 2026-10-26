import { describe, expect, it } from "vitest";
import { HOOK_CONTRAST_MIN, HOOK_TYPE, measuredContrast, pickTitleSpot, titleContrast } from "../src/legibility";
import { cutGrammarReport } from "../src/cut-grammar";
import { parseTimeline } from "../src/timeline";
import type { CriticFrame } from "../src/critic";

/** A frame whose rows above `split` (a fraction of the height) are `top` and below are `bottom` (gamma luma). */
function frame(top: number, bottom: number, split = 0.2): CriticFrame {
  const width = 36, height = 64, luma = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) luma[y * width + x] = y < split * height ? top : bottom;
  return { width, height, luma };
}

describe("hook legibility (ADR 0087)", () => {
  it("sizes the hook to capitals about 5 % of the frame in Playfair 600", () => {
    const capPx = 76 * 0.7 * HOOK_TYPE.size * 0.708; // the elegant scale; Playfair's cap height is 0.708 em
    expect(capPx / 1920).toBeGreaterThanOrEqual(0.045);
    expect(capPx / 1920).toBeLessThanOrEqual(0.055);
    expect(HOOK_TYPE.weight).toBe(600);
  });

  it("counts the shadow: white reads on a mid-dark wall with a strong shadow, not on a bright sky", () => {
    expect(titleContrast("#ffffff", { p10: 0.1, p90: 0.25 }, "strong")).toBeGreaterThan(HOOK_CONTRAST_MIN);
    expect(titleContrast("#ffffff", { p10: 0.6, p90: 0.8 }, "strong")).toBeLessThan(HOOK_CONTRAST_MIN);
    expect(titleContrast("#ffffff", { p10: 0.1, p90: 0.25 }, "none")).toBeLessThan(titleContrast("#ffffff", { p10: 0.1, p90: 0.25 }, "strong"));
  });

  it("puts white ink where the frame is darker and dark ink over a bright sky, or refuses", () => {
    expect(pickTitleSpot(frame(0.3, 0.3), { w: 0.6, h: 0.06 })).toMatchObject({ color: "#ffffff", shadow: "strong" });
    expect(pickTitleSpot(frame(0.95, 0.95), { w: 0.6, h: 0.06 })).toMatchObject({ color: "#111111" });
    // A busy background (branches against the sky): neither ink reaches 4.5:1 on both its darks and its lights.
    const stripes = frame(0, 0);
    stripes.luma.forEach((_, i) => { stripes.luma[i] = i % 2 ? 1 : 0; });
    expect(pickTitleSpot(stripes, { w: 0.6, h: 0.06 })).toBeNull();
    expect(measuredContrast(frame(0.95, 0.95), { x: 0.2, y: 0.1, w: 0.6, h: 0.06 }, { color: "#ffffff", shadow: "auto" })).toBeLessThan(2);
  });

  it("fails the gate on an opening title under 4.5:1", () => {
    const timeline = parseTimeline({ version: 1, texts: [], music: null, clips: [{ id: "a", assetId: "a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 }] });
    expect(cutGrammarReport(timeline, { hookContrast: 1.6 }).failures.map((f) => f.kind)).toEqual(["hook-contrast"]);
    expect(cutGrammarReport(timeline, { hookContrast: 5.2 }).pass).toBe(true);
  });
});
