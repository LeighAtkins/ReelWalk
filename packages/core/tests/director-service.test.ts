import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTimeline, clipSchema } from "../src/timeline";

const mock = vi.hoisted(() => ({ provider: "anthropic", model: "claude-opus-5-5", answer: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn(), selected: vi.fn(), sources: vi.fn(), blocked: vi.fn() }));
vi.mock("@reelwalk/db", () => ({ prisma: { aiEdit: { create: mock.create, update: mock.update }, mediaAsset: { count: mock.count, findMany: mock.selected }, aiGeneration: { findMany: mock.sources } } }));
vi.mock("@/lib/openai", () => ({ aiModel: () => mock.model, aiProvider: () => mock.provider, structuredAnswer: mock.answer }));
vi.mock("@/lib/ai-edit", () => ({ aiEditBlockedReason: mock.blocked, context: async () => ({ assets: { source: { id: "source", kind: "VIDEO", title: "Living room", durationMs: 8000, isPano: false, bpm: null, beatOffsetMs: null } }, songs: [], unused: [] }), newAssets: async () => [] }));
vi.mock("@/lib/workspace", () => ({ mediaScope: (workspaceId: string) => ({ workspaceId }) }));
const directorModule = "@/lib/ai-director";
const { directReel, directorInput } = await import(directorModule);

const user = { id: "u", workspaceId: "w" }, reel = { id: "r", title: "Villa" };
const timeline = { ...emptyTimeline(), clips: [clipSchema.parse({ id: "c", assetId: "source", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 })] };
const input = () => directorInput.parse({ requestId: "cf3fa607-76be-4b93-a392-a66142d919da", request: "Reject gigantic presenters and discontinuous roof entry", timeline, candidates: [], evidence: [] });
const plan = { note: "Need denser evidence", verdict: "changes-proposed", issues: ["Scale cannot be verified from missing frames"], limitations: "No source frames; cannot verify motion or lip sync", checks: Object.fromEntries(["scale", "cameraContinuity", "presenterContinuity", "propertyIdentity"].map(k => [k, { result: "uncertain", evidence: "No complete source evidence" }])),  edit: { ops: [], note: "No changes", questions: [], caption: null }, shots: [] };
beforeEach(() => {
  vi.clearAllMocks(); mock.provider = "anthropic"; mock.model = "claude-opus-5-5";
  mock.count.mockResolvedValue(1); mock.selected.mockResolvedValue([]); mock.sources.mockResolvedValue([{ assetId: "source" }]); mock.blocked.mockResolvedValue(null);
  mock.create.mockResolvedValue({ id: "edit" }); mock.update.mockResolvedValue({}); mock.answer.mockResolvedValue({ json: plan, model: "claude-opus-5-5", usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 } });
});
describe("app-owned director execution", () => {
  it("persists Opus's decision and baseline without writing to the reel or starting Veo", async () => {
    const result = await directReel(user, reel, input());
    expect(result.model).toBe("claude-opus-5-5"); expect(result.timeline).toEqual(timeline); expect(result.applied).toEqual([]);
    expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workspaceId: "w", reelId: "r", model: "pending" }) }));
    expect(mock.update.mock.calls[0][0].data.plan.baseline).toEqual(timeline);
    expect(mock.update.mock.calls[0][0].data.plan.plan).toEqual(plan);
    const call = mock.answer.mock.calls[0][0]; expect(call.instructions).toContain("giant presenter"); expect(call.input).toContain("Confirmed AI-generated asset IDs: [\"source\"]");
    expect(call.input).toContain("No source sheets supplied");
  });
  it("refuses unavailable source evidence and invalid timestamps before paid work", async () => {
    const image = "data:image/jpeg;base64,YWJj";
    await expect(directReel(user, reel, { ...input(), evidence: [{ assetId: "foreign", timesMs: [0], image }] })).rejects.toThrow("not from");
    await expect(directReel(user, reel, { ...input(), evidence: [{ assetId: "source", timesMs: [8000], image }] })).rejects.toThrow("outside");
    expect(mock.answer).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  });
  it("never silently retries an ambiguous Opus submission or switches providers", async () => {
    mock.answer.mockRejectedValue(new Error("Connection lost after submission"));
    await expect(directReel(user, reel, input())).rejects.toThrow("Connection lost");
    expect(mock.answer).toHaveBeenCalledTimes(1); expect(mock.update).not.toHaveBeenCalled();
    mock.provider = "openai";
    await expect(directReel(user, reel, input())).rejects.toThrow("Connect Claude Opus");
    expect(mock.answer).toHaveBeenCalledTimes(1);
  });
  it("does not accept Opus references to foreign or out-of-range media", async () => {
    mock.answer.mockResolvedValue({ json: { ...plan, shots: [{ title: "Retry", reason: "Scale", prompt: "Human-scale presenter in the room", durationSeconds: 8, first: { assetId: "foreign", atMs: 0 }, last: null }] }, model: "claude-opus-5-5", usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 } });
    await expect(directReel(user, reel, input())).rejects.toThrow("unavailable");
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("refuses a ready verdict without sampled AI footage even if the model claims every check passed", async () => {
    mock.answer.mockResolvedValue({ json: { ...plan, verdict: "ready", checks: Object.fromEntries(["scale", "cameraContinuity", "presenterContinuity", "propertyIdentity"].map(k => [k, { result: "pass", evidence: "Unsubstantiated" }])) }, model: "claude-opus-5-5", usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 } });
    await expect(directReel(user, reel, input())).rejects.toThrow("without enough AI source-frame evidence");
    expect(mock.update).not.toHaveBeenCalled();
  });
});
