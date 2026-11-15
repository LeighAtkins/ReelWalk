import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyframeError } from "@reelwalk/db";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), list: vi.fn(), wake: vi.fn(), continuePair: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => ({ id: "u", workspaceId: "w" }) }));
vi.mock("@/lib/ai-keyframes", () => ({ generateKeyframe: mocks.generate, listKeyframes: mocks.list, keyframeArtifact: vi.fn(), useKeyframe: vi.fn(), continueKeyframePair: mocks.continuePair }));
vi.mock("@/lib/render-capacity", () => ({ ensureWorkerRunning: mocks.wake }));
import { GET, POST } from "../app/api/ai/keyframes/route";
const input = { action: "generate", requestId: "4ec2359d-c4af-490b-b5ec-36a88f499605", role: "end", source: { assetId: "photo", atMs: 0 }, move: "shift-right", distanceM: 3, durationSeconds: 4 };
const post = () => POST(new Request("http://fixture.invalid/api/ai/keyframes", { method: "POST", headers: { origin: "http://fixture.invalid", "Content-Type": "application/json" }, body: JSON.stringify(input) }));
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("APP_URL", "http://fixture.invalid"); });

describe("keyframe HTTP recovery", () => {
  it("retrieves exact retained card associations without submitting a generation", async () => {
    mocks.list.mockResolvedValue({ jobs: [] });
    await GET(new Request("http://fixture.invalid/api/ai/keyframes?requestId=saved-request&jobId=approved-frame"));
    expect(mocks.list).toHaveBeenCalledWith({ id: "u", workspaceId: "w" }, { requestId: "saved-request", jobId: "approved-frame" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("reports an ambiguous commit as 500 and exposes the original request during reconciliation", async () => {
    const committed = { id: "original", requestId: input.requestId, status: "QUEUED" };
    mocks.generate.mockImplementation(async () => { mocks.list.mockResolvedValue({ jobs: [committed] }); throw new Error("Connection lost after commit"); });
    expect((await post()).status).toBe(500);
    const recovered = await GET(new Request("http://fixture.invalid/api/ai/keyframes"));
    expect((await recovered.json()).jobs).toEqual([committed]);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
  it("keeps a conclusive business rejection recoverable as a client error", async () => {
    mocks.generate.mockRejectedValue(new KeyframeError("No credits reserved", 409));
    expect((await post()).status).toBe(409);
    expect(mocks.wake).not.toHaveBeenCalled();
  });
  it("does not turn UNKNOWN history polling into standing worker demand", async () => {
    mocks.list.mockResolvedValue({ jobs: [{ id: "paid", status: "UNKNOWN" }] });
    await GET(new Request("http://fixture.invalid/api/ai/keyframes"));
    expect(mocks.wake).not.toHaveBeenCalled();
  });
  it("explicit status recovery wakes one pass without a generation request", async () => {
    mocks.list.mockResolvedValue({ jobs: [{ id: "paid", status: "UNKNOWN" }] });
    expect((await GET(new Request("http://fixture.invalid/api/ai/keyframes?recover=1"))).status).toBe(200);
    expect(mocks.wake).toHaveBeenCalledTimes(1);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("does not wake recovery for finished history", async () => {
    mocks.list.mockResolvedValue({ jobs: [{ status: "CANDIDATE" }] });
    await GET(new Request("http://fixture.invalid/api/ai/keyframes?recover=1"));
    expect(mocks.wake).not.toHaveBeenCalled();
  });
  it("continues a pair only through explicit POST and returns the retained Start separately", async () => {
    const result = { job: { id: "start", status: "USED" }, endJob: { id: "end", status: "QUEUED" }, continuationError: null };
    mocks.continuePair.mockResolvedValue(result);
    const response = await POST(new Request("http://fixture.invalid/api/ai/keyframes", { method: "POST", headers: { origin: "http://fixture.invalid" }, body: JSON.stringify({ action: "continue-pair", jobId: "start" }) }));
    expect(response.status).toBe(202); expect(await response.json()).toEqual(result);
    expect(mocks.continuePair).toHaveBeenCalledWith({ id: "u", workspaceId: "w" }, "start");
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.wake).toHaveBeenCalledOnce();
    mocks.list.mockResolvedValue({ jobs: [{ id: "start", status: "USED" }] });
    await GET(new Request("http://fixture.invalid/api/ai/keyframes?jobId=start"));
    expect(mocks.continuePair).toHaveBeenCalledOnce();
  });
});
