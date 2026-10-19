import { describe, expect, it } from "vitest";
import { DIRECTOR_LOOP_MAX_ROUNDS, directorLoopBrief, directorLoopStep } from "../src";

const shot = (durationSeconds: 4 | 8) => ({ durationSeconds }) as never;
const state = { round: 0, maxRounds: DIRECTOR_LOOP_MAX_ROUNDS, budgetCredits: 3, spentCredits: 0 };

describe("director run decisions", () => {
  it("stops when Opus is happy or has nothing to make", () => {
    expect(directorLoopStep({ verdict: "ready", shots: [shot(4)] }, state).kind).toBe("done");
    expect(directorLoopStep({ verdict: "changes-proposed", shots: [] }, state).kind).toBe("done");
  });

  it("makes the first shot that fits what is left of the budget", () => {
    expect(directorLoopStep({ verdict: "needs-generation", shots: [shot(8), shot(4)] }, state)).toEqual({ kind: "generate", index: 0, credits: 2 });
    expect(directorLoopStep({ verdict: "needs-generation", shots: [shot(8), shot(4)] }, { ...state, spentCredits: 2 })).toEqual({ kind: "generate", index: 1, credits: 1 });
    const over = directorLoopStep({ verdict: "needs-generation", shots: [shot(8)] }, { ...state, spentCredits: 2 });
    expect(over).toMatchObject({ kind: "done" });
    expect((over as { reason: string }).reason).toContain("needs 2 credits");
  });

  it("stops at the round limit", () => {
    const step = directorLoopStep({ verdict: "needs-generation", shots: [shot(4)] }, { ...state, round: 4, spentCredits: 3 });
    expect(step).toMatchObject({ kind: "done" });
    expect((step as { reason: string }).reason).toContain("4 rounds");
  });

  it("writes the follow-up brief around the original ask and the new take", () => {
    const brief = directorLoopBrief("Make her land in front of the house.", 1, { title: "Clean landing", fileName: "AI shot — landing.mp4" });
    expect(brief.startsWith("Make her land in front of the house.")).toBe(true);
    expect(brief).toContain("Round 2");
    expect(brief).toContain('"Clean landing"');
    expect(directorLoopBrief("Tidy the captions.", 0, null)).not.toContain("is ready");
  });
});
