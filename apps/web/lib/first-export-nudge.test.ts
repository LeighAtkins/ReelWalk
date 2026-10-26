import { describe, expect, it } from "vitest";
import { firstExportNudge } from "./first-export-nudge";

describe("firstExportNudge", () => {
  it("is the Agent plan by default, in the words the owner wrote", () => {
    const nudge = firstExportNudge(null, { yearlyAvailable: true });
    expect(nudge.message).toBe("Want this every week? Agent plan: 40 exports a month, no watermark, AI polish.");
    expect(nudge).toMatchObject({ plan: "AGENT", interval: "month", price: "A$39 a month, GST included.", button: "Get Agent" });
  });

  it("follows the plan picked on the pricing page", () => {
    const nudge = firstExportNudge({ intent_plan: "OFFICE", intent_interval: "year", utm_source: "meta" }, { yearlyAvailable: true });
    expect(nudge).toMatchObject({ plan: "OFFICE", interval: "year", price: "A$990 a year, GST included.", button: "Get Studio" });
    expect(nudge.message).toBe("Want this every week? Studio plan: 200 exports a month, no watermark, AI polish.");
  });

  it("falls back to monthly when the yearly price is not on sale", () => {
    expect(firstExportNudge({ intent_plan: "AGENT", intent_interval: "year" }, { yearlyAvailable: false })).toMatchObject({ interval: "month", price: "A$39 a month, GST included." });
  });

  it("ignores a stored intent that is not a paid plan", () => {
    expect(firstExportNudge({ intent_plan: "FREE" }, { yearlyAvailable: true }).plan).toBe("AGENT");
    expect(firstExportNudge("nonsense", { yearlyAvailable: true }).plan).toBe("AGENT");
  });
});
