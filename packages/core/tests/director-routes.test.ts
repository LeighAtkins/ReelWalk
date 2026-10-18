import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { directorPlanSchema } from "../src/ai-director";
import { directorGenerationRequestId } from "../../../apps/web/lib/director-request";

const mocks = vi.hoisted(() => ({ user: { id: "u", workspaceId: "w", email: "owner@test.invalid" } as { id: string; workspaceId: string; email: string } | null, find: vi.fn(), generate: vi.fn(), wake: vi.fn(), direct: vi.fn(), findJob: vi.fn(), createJob: vi.fn(), updateJob: vi.fn(), findReel: vi.fn(), provider: "anthropic", model: "claude-opus-5-5" }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => mocks.user }));
vi.mock("@reelwalk/db", () => ({ prisma: { aiEdit: { findFirst: mocks.find }, aiJob: { findUnique: mocks.findJob, create: mocks.createJob, update: mocks.updateJob }, reel: { findFirst: mocks.findReel } } }));
vi.mock("@/lib/ai-video", () => ({ createAiGeneration: mocks.generate }));
vi.mock("@/lib/render-capacity", () => ({ ensureWorkerRunning: mocks.wake }));
vi.mock("@/lib/openai", () => ({ aiProvider: () => mocks.provider, aiModel: () => mocks.model }));
vi.mock("@/lib/ai-edit", () => ({ newAssets: async () => [] }));
vi.mock("@/lib/ai-director", () => ({ directReel: mocks.direct, directorInput: z.object({ requestId: z.string().uuid(), request: z.string().min(3), timeline: z.unknown(), candidates: z.array(z.string()), evidence: z.array(z.unknown()) }) }));
// Web routes are compiled by the web workspace; load them under Vitest's web aliases here.
const approvalModule = "@/app/api/reels/[id]/director/generate/route";
const directorModule = "@/app/api/reels/[id]/director/route";
const { POST: approve } = await import(approvalModule);
const { POST: direct } = await import(directorModule);

const params = { params: Promise.resolve({ id: "reel" }) };
const plan = directorPlanSchema.parse({ note: "Review scale", verdict: "needs-generation", issues: [], limitations: "Sampled frames only", checks: Object.fromEntries(["scale", "cameraContinuity", "presenterContinuity", "propertyIdentity"].map(k => [k, { result: "uncertain", evidence: "No complete source evidence" }])),  edit: { ops: [], note: "", questions: [], caption: null }, shots: [{ title: "Descent", reason: "Keep human scale", prompt: "An uninterrupted human-scale descent into the referenced room.", durationSeconds: 8, first: { assetId: "house", atMs: 1000 }, last: { assetId: "room", atMs: 0 } }] });
const body = { editId: "edit", index: 0, approved: true };
const request = (data: unknown, origin = "https://reelwalking.com") => new Request("https://reelwalking.com/api/reels/reel/director", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.clearAllMocks(); mocks.user = { id: "u", workspaceId: "w", email: "owner@test.invalid" }; mocks.provider = "anthropic"; mocks.model = "claude-opus-5-5";
  mocks.find.mockResolvedValue({ model: "claude-opus-5-5", plan: { kind: "director", plan } });
  mocks.generate.mockResolvedValue({ id: "generation" }); mocks.wake.mockResolvedValue(undefined);
  mocks.findJob.mockResolvedValue(null); mocks.createJob.mockResolvedValue({}); mocks.updateJob.mockResolvedValue({}); mocks.findReel.mockResolvedValue({ id: "reel", title: "Villa" }); mocks.direct.mockResolvedValue({ ok: true });
  process.env.APP_URL = "https://reelwalking.com";
});

describe("Opus generation approval", () => {
  it("requires login, same origin and specific consent before any generation", async () => {
    mocks.user = null; expect((await approve(request(body), params)).status).toBe(401);
    mocks.user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
    expect((await approve(request(body, "https://other.invalid"), params)).status).toBe(403);
    expect((await approve(request({ ...body, approved: false }), params)).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("scopes decisions to this workspace and reel; rejects foreign and non-Opus plans", async () => {
    mocks.find.mockResolvedValue(null); expect((await approve(request(body), params)).status).toBe(404);
    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "edit", reelId: "reel", workspaceId: "w" } }));
    mocks.find.mockResolvedValue({ model: "other-model", plan: { kind: "director", plan } });
    expect((await approve(request(body), params)).status).toBe(404); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("executes the stored prompt unchanged and uses stable identity across lost responses", async () => {
    mocks.wake.mockRejectedValueOnce(new Error("Worker wake lost"));
    expect((await approve(request({ ...body, prompt: "browser replacement", durationSeconds: 4 }), params)).status).toBe(409);
    expect((await approve(request(body), params)).status).toBe(202);
    const first = mocks.generate.mock.calls[0], second = mocks.generate.mock.calls[1];
    expect(first[1]).toEqual(second[1]); expect(first[1].prompt).toBe(plan.shots[0].prompt);
    expect(first[1].durationSeconds).toBe(8); expect(first[2]).toEqual({ exactPrompt: true });
    expect(z.string().uuid().safeParse(first[1].requestId).success).toBe(true);
    expect(first[1].requestId).not.toBe(directorGenerationRequestId("edit", 1));
    expect(first[1].requestId).not.toBe(directorGenerationRequestId("another-edit", 0));
  });
});

describe("paid director review identity", () => {
  const brief = { requestId: "cf3fa607-76be-4b93-a392-a66142d919da", request: "Keep the presenter human-sized", timeline: {}, candidates: [], evidence: [] };
  it("resumes an identical review without another model call, but refuses changed content", async () => {
    let stored: unknown = null;
    mocks.createJob.mockImplementation(async ({ data }) => { stored = data; return data; });
    mocks.findJob.mockImplementation(async () => stored);
    expect((await direct(request(brief), params)).status).toBe(202);
    expect((await direct(request(brief), params)).status).toBe(200);
    expect(mocks.direct).toHaveBeenCalledTimes(1);
    expect((await direct(request({ ...brief, request: "Changed brief" }), params)).status).toBe(409);
    expect(mocks.direct).toHaveBeenCalledTimes(1);
  });
  it("refuses another studio's request identity and an explicitly configured non-Opus provider", async () => {
    mocks.findJob.mockResolvedValue({ workspaceId: "other", reelId: "reel", kind: "director", result: {} });
    expect((await direct(request(brief), params)).status).toBe(409);
    mocks.provider = "openai"; expect((await direct(request(brief), params)).status).toBe(409);
    expect(mocks.direct).not.toHaveBeenCalled();
  });
  it("bounds chunked evidence before starting paid work", async () => {
    const oversized = new Request("https://reelwalking.com/api/reels/reel/director", { method: "POST", headers: { origin: "https://reelwalking.com" }, body: "x".repeat(8_000_001) });
    expect((await direct(oversized, params)).status).toBe(413); expect(mocks.createJob).not.toHaveBeenCalled(); expect(mocks.direct).not.toHaveBeenCalled();
  });
});
