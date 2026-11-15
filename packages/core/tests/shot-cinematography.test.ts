import { describe, expect, it } from "vitest";
import { DEFAULT_SHOT_CINEMATOGRAPHY, nanoCinematographyPrompt, shotCinematographySchema, videoCinematographyPrompt } from "../src/shot-cinematography";

describe("shared keyframe cinematography", () => {
  it("keeps the source optics and lighting by default instead of imposing a daylight or wide-lens conversion", () => {
    const text = nanoCinematographyPrompt(DEFAULT_SHOT_CINEMATOGRAPHY);
    expect(text).toContain("Match the source's optical perspective and field of view");
    expect(text).toContain("Match the source's white balance and exposure");
    expect(text).toContain("straight verticals");
    expect(text).toContain("no extra sharpening");
    expect(text).not.toMatch(/\d+ (?:mm|K)/);
  });

  it("puts explicit lens and white-balance guidance into Nano while Veo preserves the resulting frames", () => {
    const look = { version: 1, lensMm: 35, whiteBalanceKelvin: 4300 } as const;
    const image = nanoCinematographyPrompt(look), video = videoCinematographyPrompt(look);
    expect(image).toContain("35 mm-equivalent lens look as creative guidance");
    expect(image).toContain("4300 K camera white-balance look in both keyframes");
    expect(image).toContain("Retain the source light direction and time of day");
    expect(video).toContain("supplied Start and End frames' optical perspective, white balance, exposure");
    expect(video).toContain("Do not introduce a new lens, relight the scene");
    expect(video).not.toMatch(/35|4300/);
  });

  it.each([24, 35, 50] as const)("accepts the supported %s mm lens look without mutating the source-matched default", lensMm => {
    expect(nanoCinematographyPrompt({ ...DEFAULT_SHOT_CINEMATOGRAPHY, lensMm })).toContain(`${lensMm} mm-equivalent`);
    expect(DEFAULT_SHOT_CINEMATOGRAPHY.lensMm).toBe("source");
  });

  it("bounds Kelvin guidance and rejects unsupported settings without silently substituting", () => {
    for (const whiteBalanceKelvin of [2500, 7500]) expect(shotCinematographySchema.safeParse({ ...DEFAULT_SHOT_CINEMATOGRAPHY, whiteBalanceKelvin }).success).toBe(true);
    for (const whiteBalanceKelvin of [2499, 7501, 3200.5, Infinity, NaN, "5600"]) expect(shotCinematographySchema.safeParse({ ...DEFAULT_SHOT_CINEMATOGRAPHY, whiteBalanceKelvin }).success).toBe(false);
    expect(shotCinematographySchema.safeParse({ ...DEFAULT_SHOT_CINEMATOGRAPHY, lensMm: 16 }).success).toBe(false);
    expect(shotCinematographySchema.safeParse({ ...DEFAULT_SHOT_CINEMATOGRAPHY, version: 2 }).success).toBe(false);
    expect(shotCinematographySchema.safeParse({ ...DEFAULT_SHOT_CINEMATOGRAPHY, exposure: "auto" }).success).toBe(false);
  });
});
