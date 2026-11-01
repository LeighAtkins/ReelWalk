import { describe, expect, it, vi } from "vitest";
import { shotPlanSchema, type Gray, type PlanState } from "@reelwalk/core";
import { measureTake, refreshTakes, runPlanStep, type PlanDeps } from "../src/shot-plans";

const W = 72, H = 128;
/** A textured picture (0..255, as the motion code reads grey frames) shifted by (dx, dy) px and scaled about the centre: a synthetic camera move. */
function picture(dx = 0, dy = 0, scale = 1): Gray {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x - W / 2) / scale + W / 2 - dx, v = (y - H / 2) / scale + H / 2 - dy;
    data[y * W + x] = 255 * (0.5 + 0.25 * Math.sin(u * 0.45) * Math.cos(v * 0.31) + 0.2 * Math.sin((u + v) * 0.17));
  }
  return { data, width: W, height: H };
}
const take = (step: (i: number) => Gray, count = 60) => Array.from({ length: count }, (_, i) => ({ t: Math.round((i * 1000) / 30), gray: step(i) }));

const plan = shotPlanSchema.parse({
  version: 1, title: "Villa flight", look: "A Mediterranean villa in late sun.",
  shots: [
    { id: "hall", purpose: "feature", place: "hall", pov: "eye level", seconds: 8, motion: "pan-right", action: "the camera turns right across the hall",
      start: { description: "the hall", assetId: "kf-a" }, end: { description: "the kitchen arch", assetId: "kf-b" }, transitionOut: { kind: "continuous" } },
    { id: "kitchen", purpose: "feature", place: "kitchen", pov: "eye level", seconds: 8, motion: "pan-right", action: "it keeps turning right",
      start: { description: "carrying on", source: "previous" }, end: { description: "the terrace", assetId: "kf-c" } },
  ],
});
const row = { id: "plan1", workspaceId: "ws", approval: "storyboard", budgetCredits: 20, presenterId: null, plan, state: {}, reelId: null, createdBy: { id: "u", workspaceId: "ws", email: "o@x" } };
const empty: PlanState = { shots: {}, storyboardApproved: true, assembled: false };

function fakes(over: Partial<PlanDeps> = {}): PlanDeps {
  return {
    makeKeyframe: vi.fn(async () => "kf-new"),
    startTake: vi.fn(async () => ({ id: "gen1", credits: 2 })),
    takeStatus: vi.fn(async () => ({ status: "waiting" as const })),
    takeFrames: vi.fn(async () => take((i) => picture(-i * 0.4))),
    stillFrame: vi.fn(async (f) => (f.assetId === "kf-b" ? picture(-59 * 0.4) : picture())),
    requestId: (p, s, n) => `${p}-${s}-${n}`,
    ...over,
  };
}

describe("measureTake", () => {
  it("reads a pan right and an exact landing", () => {
    // Content sliding left = the camera turning right.
    const frames = take((i) => picture(-i * 0.4));
    const m = measureTake(frames, picture(), picture(-59 * 0.4));
    expect(m.motion?.kind).toBe("pan-x");
    expect(m.motion!.tx).toBeLessThan(0);
    expect(m.startChange).toBeLessThan(0.01);
    expect(m.endChange).toBeLessThan(0.01);
  });
  it("sees a take that ends somewhere else", () => {
    const m = measureTake(take((i) => picture(-i * 0.4)), picture(), picture(20, 30, 1.4));
    expect(m.endChange).toBeGreaterThan(0.06);
  });
  it("reads a push in", () => {
    expect(measureTake(take((i) => picture(0, 0, 1 + i * 0.006)), null, null).motion?.kind).toBe("zoom-in");
  });
});

describe("runPlanStep", () => {
  it("starts a take between the planned stills, with the plan's prompt", async () => {
    const deps = fakes();
    const out = await runPlanStep(row, plan, empty, { kind: "take", shotId: "hall", attempt: 1, note: "" }, deps, new Map());
    expect(deps.startTake).toHaveBeenCalledWith(expect.objectContaining({ requestId: "plan1-hall-0", first: { assetId: "kf-a", atMs: 0 }, last: { assetId: "kf-b", atMs: 0 } }));
    expect(out.state.shots.hall.takes).toEqual([expect.objectContaining({ aiShotId: "gen1", status: "queued", credits: 2 })]);
  });
  it("passes a take that turned right and landed, and fails one that turned left", async () => {
    const made: PlanState = { ...empty, shots: { hall: { takes: [{ aiShotId: "gen1", assetId: "ai-gen1", status: "checking", credits: 2 }], attemptsFrom: 0 } } };
    const good = await runPlanStep(row, plan, made, { kind: "check", shotId: "hall", aiShotId: "gen1" }, fakes(), new Map([["ai-gen1", 2000]]));
    expect(good.state.shots.hall.takes[0]).toMatchObject({ status: "passed", verdict: { pass: true } });
    const wrong = await runPlanStep(row, plan, made, { kind: "check", shotId: "hall", aiShotId: "gen1" }, fakes({ takeFrames: vi.fn(async () => take((i) => picture(i * 0.4))) }), new Map());
    expect(wrong.state.shots.hall.takes[0].status).toBe("failed");
    expect(wrong.state.shots.hall.takes[0].verdict!.problems.join(" ")).toContain("wrong way");
  });
  it("continues the next shot from the accepted take's last frame", async () => {
    const deps = fakes();
    const accepted: PlanState = { ...empty, shots: { hall: { takes: [{ aiShotId: "gen1", assetId: "ai-gen1", status: "accepted", credits: 2 }], acceptedAiShotId: "gen1", attemptsFrom: 0 } } };
    await runPlanStep(row, plan, accepted, { kind: "take", shotId: "kitchen", attempt: 1, note: "" }, deps, new Map([["ai-gen1", 8000]]));
    expect(deps.startTake).toHaveBeenCalledWith(expect.objectContaining({ first: { assetId: "ai-gen1", atMs: 7960 }, last: { assetId: "kf-c", atMs: 0 } }));
  });
  it("parks the plan for the owner, but keeps polling while a take is made", async () => {
    expect(await runPlanStep(row, plan, empty, { kind: "wait", reason: "storyboard" }, fakes(), new Map())).toMatchObject({ status: "waiting", waitingFor: "storyboard" });
    expect(await runPlanStep(row, plan, empty, { kind: "wait", reason: "generating", shotId: "hall" }, fakes(), new Map())).toMatchObject({ status: "running", delayMs: 20000 });
  });
});

describe("refreshTakes", () => {
  it("moves made takes to checking and failed ones to failed with their credits returned", async () => {
    const state: PlanState = { ...empty, shots: { hall: { takes: [{ aiShotId: "a", status: "generating", credits: 2 }, { aiShotId: "b", status: "queued", credits: 2 }], attemptsFrom: 0 } } };
    const next = await refreshTakes(plan, state, { takeStatus: async (id) => (id === "a" ? { status: "succeeded", assetId: "ai-a" } : { status: "failed", error: "The video service could not start this shot." }) });
    expect(next.shots.hall.takes).toEqual([
      expect.objectContaining({ aiShotId: "a", status: "checking", assetId: "ai-a" }),
      expect.objectContaining({ aiShotId: "b", status: "failed", credits: 0 }),
    ]);
  });
});
