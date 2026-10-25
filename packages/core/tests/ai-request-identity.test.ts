import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTimeline } from "../src";

// ADR 0049 review item 2: one user action is one request id, reused when the
// start is retried, and the Ask route hands it to the run (durable) or job (in-process).
const mocks = vi.hoisted(() => ({ durable: true, startRun: vi.fn(), startJob: vi.fn() }));
// The workspace AI switch has its own tests (apps/web/lib/ai-off.test.ts); here every workspace has AI on.
vi.mock("@/lib/ai-gate", () => ({ aiOffResponse: async () => null, aiIsOff: async () => false, assertAiOn: async () => undefined, AI_OFF_MESSAGE: "off" }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => ({ id: "u", workspaceId: "w" }) }));
vi.mock("@reelwalk/db", () => ({ prisma: { reel: { findFirst: async () => ({ id: "reel", title: "Villa", timeline: null }) }, mediaAsset: { count: async () => 0 } } }));
vi.mock("@/lib/workflows", () => ({ durableAiJobs: () => mocks.durable, startSingleStepRun: mocks.startRun }));
vi.mock("@/lib/ai-jobs", () => ({ startAiJob: mocks.startJob }));
vi.mock("@/lib/ai-steps", () => ({ runAiStep: vi.fn() }));

const { runAiJob } = await import("../../../apps/web/lib/ai-jobs-client");
const askModule = "@/app/api/reels/[id]/ai-edit/route";
const { POST: ask } = await import(askModule);

describe("runAiJob request identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries a start that got no response with the same request id, then polls", async () => {
    const bodies: { requestId: string }[] = [];
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        if (++posts === 1) throw new TypeError("network changed");
        if (posts === 2) return new Response("bad gateway", { status: 502 });
        return Response.json({ ok: true, jobId: "step-1" });
      }
      expect(url).toBe("/api/ai-jobs/step-1");
      return Response.json({ status: "DONE", durable: true, result: { ok: true, note: "done" } });
    }));
    const result = await runAiJob<{ ok: true; note: string }>("/api/reels/r/ai-edit", { request: "calmer" }, { retryDelayMs: 0 });
    expect(result).toEqual({ ok: true, note: "done" });
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => b.requestId)).size).toBe(1);
    expect(bodies[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("says the request may still be running when no start got any response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const result = await runAiJob("/x", { request: "a" }, { retryDelayMs: 0 });
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/may still be running/);
  });

  it("gives each action its own id and keeps one the caller brought", async () => {
    const ids: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { ids.push(JSON.parse(String(init.body)).requestId); return Response.json({ ok: false, message: "no" }); }
      throw new Error("not polled");
    }));
    await runAiJob("/x", { request: "a" });
    await runAiJob("/x", { request: "a" });
    await runAiJob("/x", { request: "a", requestId: "11111111-1111-4111-8111-111111111111" });
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("Ask route request identity", () => {
  const requestId = "22222222-2222-4222-8222-222222222222";
  const post = () => new Request("https://reelwalking.com/api/reels/reel/ai-edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: "calmer", timeline: emptyTimeline(), requestId }) });
  const params = { params: Promise.resolve({ id: "reel" }) };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startRun.mockResolvedValue({ ok: true, jobId: "step-1", runId: "run-1", resumed: false });
    mocks.startJob.mockResolvedValue("ask-job");
  });

  it("hands the browser's request id to the durable run, so a retried POST resumes it", async () => {
    mocks.durable = true;
    await ask(post(), params);
    await ask(post(), params);
    expect(mocks.startRun).toHaveBeenCalledTimes(2);
    expect(mocks.startRun.mock.calls.map(([input]) => input.requestId)).toEqual([requestId, requestId]);
  });

  it("hands it to the in-process job too", async () => {
    mocks.durable = false;
    await ask(post(), params);
    expect(mocks.startJob.mock.calls[0][0]).toMatchObject({ kind: "ask", requestId });
  });
});
