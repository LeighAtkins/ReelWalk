import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOOK_FONT_FAMILIES } from "@reelwalk/core";
import { ELEGANT_FONT_FAMILY, REEL_FONT_FAMILY, textTreatmentCss } from "../src/reel/look";

describe("emoji fall back to a colour font", () => {
  const stacks = {
    sans: REEL_FONT_FAMILY,
    elegant: ELEGANT_FONT_FAMILY,
    hookSans: HOOK_FONT_FAMILIES.sans,
    hookSerif: HOOK_FONT_FAMILIES.serif,
    editorial: String(textTreatmentCss({ style: "plain", color: "#ffffff", size: 1, font: "editorial" }).fontFamily),
  };
  it.each(Object.entries(stacks))("%s lists Noto Color Emoji after the house fonts and before the generic family", (_name, stack) => {
    const families = stack.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
    const emoji = families.indexOf("Noto Color Emoji");
    expect(emoji).toBeGreaterThan(0);
    expect(emoji).toBe(families.length - 2);
  });
  it("keeps the worker image's emoji font and the build-time check", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("../../../apps/worker/Dockerfile", import.meta.url)), "utf8");
    expect(dockerfile).toContain("fonts-noto-color-emoji");
    expect(dockerfile).toContain('fc-list | grep -qi "Noto Color Emoji"');
  });
});
