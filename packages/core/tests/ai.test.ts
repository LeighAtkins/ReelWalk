import { describe, expect, it } from "vitest";
import { AI_CLIP_COST_CENTS, AI_CLIP_SECONDS, AI_PLAN_CREDITS, PLANS, aiCreditWindow } from "../src";

describe("AI video allowance windows", () => {
  const anchor = new Date("2026-01-31T15:30:00Z");
  const paidThrough = new Date("2027-01-31T15:30:00Z");
  it("clamps February but restores the original day in March", () => {
    expect(aiCreditWindow(anchor, paidThrough, new Date("2026-03-01T00:00:00Z"))).toEqual({
      start: new Date("2026-02-28T15:30:00Z"), end: new Date("2026-03-31T15:30:00Z"),
    });
    expect(aiCreditWindow(anchor, paidThrough, new Date("2026-04-01T00:00:00Z"))?.start).toEqual(new Date("2026-03-31T15:30:00Z"));
  });
  it("ends credits exactly at the paid-through time", () => {
    expect(aiCreditWindow(anchor, paidThrough, paidThrough)).toBeNull();
    expect(aiCreditWindow(anchor, paidThrough, new Date("2026-01-31T15:29:59Z"))).toBeNull();
  });
  it("matches the public plans and keeps eight-second generation costs bounded", () => {
    for (const plan of Object.values(PLANS)) expect(plan.aiVideoClips).toBe(AI_PLAN_CREDITS[plan.id]);
    expect(AI_CLIP_SECONDS).toBe(8);
    expect(AI_CLIP_COST_CENTS).toBe(80);
  });
});
