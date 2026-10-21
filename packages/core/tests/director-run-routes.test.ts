import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR 0049 review item 6: a run's ending records what happened, and a review
// refused because another tab has the round tells the sheet why.
const mocks = vi.hoisted(() => ({ endRun: vi.fn(), addReview: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => ({ id: "u", workspaceId: "w" }) }));
vi.mock("@/lib/workflows", () => ({
  endRun: mocks.endRun, advanceRun: vi.fn(), noteRun: vi.fn(), findDirectorRun: vi.fn(), publicRun: vi.fn(),
  durableAiJobs: () => true, addDirectorReview: mocks.addReview, startSingleStepRun: vi.fn(), activeDirectorRun: vi.fn(),
}));
vi.mock("@/lib/openai", () => ({ aiProvider: () => "anthropic", aiModel: () => "claude-opus-5-5" }));
vi.mock("@/lib/ai-edit", () => ({ newAssets: async () => [] }));
vi.mock("@reelwalk/db", () => ({ prisma: { reel: { findFirst: async () => ({ id: "reel", title: "Villa" }) } } }));

const runModule = "@/app/api/reels/[id]/director/runs/[runId]/route";
const directorModule = "@/app/api/reels/[id]/director/route";
const { POST: runAction } = await import(runModule);
const { POST: direct } = await import(directorModule);
const params = { params: Promise.resolve({ id: "reel", runId: "run-1" }) };
const post = (url: string, body: unknown) => new Request(`https://reelwalking.com${url}`, { method: "POST", headers: { origin: "https://reelwalking.com", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); process.env.APP_URL = "https://reelwalking.com"; mocks.endRun.mockResolvedValue({ run: { id: "run-1" }, applied: true }); });

describe("director run endings", () => {
  it("records a failure as failed and only a finished loop as succeeded", async () => {
    await runAction(post("/api/reels/reel/director/runs/run-1", { action: "finish", message: "Opus could not finish this round.", outcome: "failed" }), params);
    await runAction(post("/api/reels/reel/director/runs/run-1", { action: "finish", message: "Opus is happy with the reel." , outcome: "succeeded" }), params);
    await runAction(post("/api/reels/reel/director/runs/run-1", { action: "stop" }), params);
    expect(mocks.endRun.mock.calls.map(([input]) => input.outcome)).toEqual(["failed", "succeeded", "stopped"]);
  });
});

describe("a stale tab's ending", () => {
  it("is refused when the run has moved on, and reports the current run", async () => {
    mocks.endRun.mockResolvedValue({ run: { id: "run-1", status: "FAILED", cancelRequested: true }, applied: false });
    const response = await runAction(post("/api/reels/reel/director/runs/run-1", { action: "finish", message: "Opus is happy.", outcome: "succeeded" }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, run: { status: "FAILED" } });
  });
});

describe("a review another tab already has", () => {
  it("is refused with its reason so the sheet follows the run instead of ending it", async () => {
    mocks.addReview.mockResolvedValue({ ok: false, status: 409, message: "This round has already been reviewed.", reason: "reviewed" });
    const body = { requestId: "33333333-3333-4333-8333-333333333333", request: "Check the take", timeline: {}, candidates: [], evidence: [], workflowRunId: "run-1" };
    const response = await direct(post("/api/reels/reel/director", body), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, reason: "reviewed" });
  });
});
