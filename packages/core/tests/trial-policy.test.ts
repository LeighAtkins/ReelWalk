import { describe, expect, it } from "vitest";
import { canDirectAiVideo, listingTrialExpired, trialEndsAt } from "../src";
describe("trial and video spending policy", () => {
    it("never allows automatic Veo spending on a free or comped trial", () => { expect(canDirectAiVideo({ plan: "FREE", aiVideoMode: "AUTO" })).toBe(false); });
    it("requires a paid plan and standing consent", () => { expect(canDirectAiVideo({ plan: "AGENT", aiVideoMode: "ASK" })).toBe(false); expect(canDirectAiVideo({ plan: "AGENT", aiVideoMode: "AUTO" })).toBe(true); });
    it("ends full trial exports at exactly seven days without changing legacy free accounts", () => { const start = new Date("2026-10-18T00:00:00Z"), end = trialEndsAt(start); expect(end.toISOString()).toBe("2026-10-25T00:00:00.000Z"); const ws = { plan: "FREE", trialStartedAt: start, compedUntil: end }; expect(listingTrialExpired(ws, new Date(end.getTime() - 1))).toBe(false); expect(listingTrialExpired(ws, end)).toBe(true); expect(listingTrialExpired({ ...ws, plan: "AGENT" }, end)).toBe(false); expect(listingTrialExpired({ ...ws, trialStartedAt: null }, end)).toBe(false); });
});
