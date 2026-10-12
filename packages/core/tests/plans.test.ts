import { describe, expect, it } from "vitest";
import { effectivePlan, isBillingInterval, monthStart, outputSize, PLAN_IDS, planPrice, PLANS, yearlyMonthsFree, yearlyPerMonth } from "../src/plans";

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

  it("keeps the stored ids while OFFICE shows as Studio", () => {
    expect(PLAN_IDS).toEqual(["FREE", "AGENT", "OFFICE"]);
    expect(PLANS.OFFICE.name).toBe("Studio");
    expect(PLANS.AGENT.name).toBe("Agent");
  });

  it("free is 3 exports a month with no Instagram; Agent and Studio post to Instagram", () => {
    expect(PLANS.FREE.exportsPerMonth).toBe(3);
    expect(PLANS.FREE.instagram).toBe(false);
    expect(PLANS.AGENT.exportsPerMonth).toBe(40);
    expect(PLANS.AGENT.instagram).toBe(true);
    expect(PLANS.OFFICE.exportsPerMonth).toBe(200);
    expect(PLANS.OFFICE.seats).toBe(5);
  });

  it("a year costs ten months: two free", () => {
    expect(planPrice(PLANS.AGENT, "month")).toBe(29);
    expect(planPrice(PLANS.AGENT, "year")).toBe(290);
    expect(planPrice(PLANS.OFFICE, "year")).toBe(790);
    expect(planPrice(PLANS.FREE, "year")).toBe(0);
    expect(yearlyMonthsFree(PLANS.AGENT)).toBe(2);
    expect(yearlyMonthsFree(PLANS.OFFICE)).toBe(2);
    expect(yearlyMonthsFree(PLANS.FREE)).toBe(0);
    expect(yearlyPerMonth(PLANS.AGENT)).toBeCloseTo(24.17, 2);
  });

  it("knows its billing intervals", () => {
    expect(isBillingInterval("month")).toBe(true);
    expect(isBillingInterval("year")).toBe(true);
    expect(isBillingInterval("week")).toBe(false);
    expect(isBillingInterval(undefined)).toBe(false);
  });
});
