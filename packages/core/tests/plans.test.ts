import { describe, expect, it } from "vitest";
import { effectivePlan, monthStart, outputSize, PLANS } from "../src/plans";

const day = (iso: string) => new Date(iso);

describe("effectivePlan", () => {
  it("is Free with nothing set", () => {
    expect(effectivePlan({ plan: "FREE", compedPlan: null, compedUntil: null })).toBe("FREE");
  });

  it("a paid plan wins over a comped one", () => {
    expect(effectivePlan({ plan: "OFFICE", compedPlan: "AGENT", compedUntil: day("2099-01-01") })).toBe("OFFICE");
  });

  it("a comped plan counts until its date, then stops", () => {
    const workspace = { plan: "FREE" as const, compedPlan: "AGENT" as const, compedUntil: day("2026-11-01T00:00:00Z") };
    expect(effectivePlan(workspace, day("2026-10-31T23:59:59Z"))).toBe("AGENT");
    expect(effectivePlan(workspace, day("2026-11-01T00:00:00Z"))).toBe("FREE");
  });

  it("a comped plan without a date gives nothing", () => {
    expect(effectivePlan({ plan: "FREE", compedPlan: "AGENT", compedUntil: null })).toBe("FREE");
  });
});

describe("monthStart", () => {
  it("is the first of the month in UTC, whatever the local zone", () => {
    expect(monthStart(day("2026-10-12T03:00:00+09:00")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthStart(day("2026-10-31T23:30:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("plans", () => {
  it("free exports are 720×1280 with a watermark; paid are 1080×1920 without", () => {
    expect(outputSize(PLANS.FREE.outputWidth)).toEqual({ width: 720, height: 1280 });
    expect(PLANS.FREE.watermark).toBe(true);
    expect(outputSize(PLANS.AGENT.outputWidth)).toEqual({ width: 1080, height: 1920 });
    expect(PLANS.OFFICE.watermark).toBe(false);
  });
});
