import { describe, expect, it, vi } from "vitest";

vi.mock("@reelwalk/db", () => ({ prisma: {} }));
vi.mock("./openai", () => ({ structuredAnswer: vi.fn() }));
vi.mock("./library", () => ({ toLibraryAssets: vi.fn() }));

const { planShots, planRequest, takeRequestId, uuidFrom, SHOT_PLAN_INSTRUCTIONS } = await import("./shot-plans");

const frame = (description: string, source = "keyframe") => ({ description, source, assetId: null, atMs: null });
const shot = (id: string, over: Record<string, unknown> = {}) => ({
  id, purpose: "feature", place: `${id} room`, pov: "eye level", reveals: null, seconds: 4, playSeconds: null, motion: "push-in", move: null,
  action: "the camera flies forward", start: frame(`the ${id} from the door`), end: frame(`the far side of the ${id}`), presenter: false, line: null,
  transitionOut: { kind: "cut", direction: null }, ...over,
});
const answer = (shots: unknown[]) => ({ json: { title: "Villa", look: "A villa in late sun.", outfit: null, shots }, usage: {}, model: "claude" });

describe("planShots", () => {
  it("keeps a clean plan from the first answer", async () => {
    const ask = vi.fn(async () => answer([shot("hall"), shot("kitchen")]));
    const { plan, issues } = await planShots("ws", { brief: "A villa tour", presenter: false, footage: [] }, ask as never);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(plan.shots.map((s) => s.id)).toEqual(["hall", "kitchen"]);
    expect(issues).toEqual([]);
  });
  it("asks once more with the continuity errors listed, and keeps the repaired plan", async () => {
    const whip = shot("hall", { motion: "pan-left", transitionOut: { kind: "whip", direction: "right" } });
    const ask = vi.fn()
      .mockResolvedValueOnce(answer([whip, shot("kitchen")]))
      .mockResolvedValueOnce(answer([shot("hall", { motion: "pan-right", transitionOut: { kind: "whip", direction: "right" } }), shot("kitchen", { motion: "pan-right" })]));
    const { plan, issues } = await planShots("ws", { brief: "A villa tour", presenter: false, footage: [] }, ask as never);
    expect(ask).toHaveBeenCalledTimes(2);
    const second = ask.mock.calls[1][0] as { input: string };
    expect(second.input).toContain("Your last plan had these continuity problems");
    expect(second.input).toContain("whip right needs");
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(plan.shots[0].motion).toBe("pan-right");
  });
  it("drops a frame that names footage it was not given", async () => {
    const ask = vi.fn(async () => answer([shot("hall", { start: { description: "the hall", source: "keyframe", assetId: "someone-elses", atMs: 0 } })]));
    const { plan } = await planShots("ws", { brief: "A villa tour", presenter: false, footage: [{ id: "mine", label: "hall", kind: "VIDEO", durationMs: 5000 }] }, ask as never);
    expect(plan.shots[0].start.assetId).toBeUndefined();
  });
});

describe("the request", () => {
  it("says the owner's rules and lists the footage it may use", () => {
    expect(SHOT_PLAN_INSTRUCTIONS).toContain("never two shots of roughly the same view");
    expect(SHOT_PLAN_INSTRUCTIONS).toContain("frame every earlier shot so it is NOT in view");
    expect(SHOT_PLAN_INSTRUCTIONS).toContain("never use the word nude");
    expect(SHOT_PLAN_INSTRUCTIONS).toContain("visible through doorways, arches and windows");
    const text = planRequest({ brief: "Tour", presenter: true, footage: [{ id: "a1", label: "kitchen", kind: "VIDEO", durationMs: 6200 }] });
    expect(text).toContain("a1 (kitchen, VIDEO, 6.2 s)");
    expect(text).toContain("A presenter is available");
  });
  it("derives the same take id for the same take, a different one for the next", () => {
    expect(takeRequestId("p1", "hall", 0)).toBe(takeRequestId("p1", "hall", 0));
    expect(takeRequestId("p1", "hall", 1)).not.toBe(takeRequestId("p1", "hall", 0));
    expect(uuidFrom("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
