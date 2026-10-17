import { describe, expect, it } from "vitest";
import { textTreatmentCss } from "../src/reel/look";

describe("text contrast independent of typography", () => {
  it("protects small serif text without enlarging it or changing its font", () => {
    const text = { style: "elegant", color: "#ffffff", size: 0.4, font: "serif" } as const;
    const strong = textTreatmentCss(text);
    const none = textTreatmentCss({ ...text, shadow: "none" });
    expect(strong.fontSize).toBe(none.fontSize);
    expect(strong.fontFamily).toBe(none.fontFamily);
    expect(strong.textShadow).toContain("rgba(0,0,0,0.95)");
    expect(strong.WebkitTextStroke).toContain("1.25px");
    expect(none.textShadow).toBe("none");
  });
  it("uses a light halo for dark lettering and leaves existing label contrast intact", () => {
    expect(textTreatmentCss({ style: "plain", color: "#111111", size: 1 }).textShadow).toContain("rgba(255,255,255");
    expect(textTreatmentCss({ style: "box", color: "#ffffff", size: 1 }).backgroundColor).toBe("#ffffff");
  });
});
