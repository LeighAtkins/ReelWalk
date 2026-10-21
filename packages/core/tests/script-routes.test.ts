import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildScriptShots, scriptRequestKey, scriptRequestSchema, type ScriptRequest } from "../src/script";
import { scriptGenerationRequestId } from "../../../apps/web/lib/director-request";

// Script mode's server path (ADR 0060). Generation itself is mocked: no provider is called.

const mocks = vi.hoisted(() => ({
  user: { id: "u", workspaceId: "w", email: "owner@test.invalid" } as { id: string; workspaceId: string; email: string } | null,
  findReel: vi.fn(), findGenerations: vi.fn(), countGenerations: vi.fn(), findAssets: vi.fn(), generate: vi.fn(), balance: vi.fn(), wake: vi.fn(),
  video: true, voice: true, lipsync: false,
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => mocks.user }));
vi.mock("@reelwalk/db", () => ({ prisma: { reel: { findFirst: mocks.findReel }, aiGeneration: { findMany: mocks.findGenerations, count: mocks.countGenerations }, mediaAsset: { findMany: mocks.findAssets } } }));
vi.mock("@/lib/library", () => ({ toLibraryAssets: async (rows: { id: string }[]) => rows.map(row => ({ id: row.id, kind: "VIDEO", durationMs: 4000 })) }));
vi.mock("@/lib/ai-video", () => ({
  createAiGeneration: mocks.generate, getAiBalance: mocks.balance,
  aiVideoConfigured: () => mocks.video, aiVoiceConfigured: () => mocks.voice, aiLipsyncConfigured: () => mocks.lipsync,
}));
vi.mock("@/lib/render-capacity", () => ({ ensureWorkerRunning: mocks.wake }));
const scriptModule = "@/app/api/reels/[id]/script/route";
const { GET: available, POST: make } = await import(scriptModule);

const params = { params: Promise.resolve({ id: "reel" }) };
const script: ScriptRequest = scriptRequestSchema.parse({
  scriptId: "8c7d4c2e-6a1f-4b7e-9d3a-1e2f3a4b5c6d", presenterId: "kit", outfit: "a navy knit dress",
  takes: [
    { line: "Welcome to Ocean House.", boundary: 0, afterClipId: null, fraction: 0, plate: { assetId: "v1", atMs: 0 }, room: "entry", light: "left" },
    { line: "The kitchen opens straight onto the garden and the pool.", boundary: 2, afterClipId: "b", fraction: 0.5, plate: { assetId: "v2", atMs: 3967 }, room: "kitchen" },
    { line: "Message me for a private tour.", boundary: 4, afterClipId: "d", fraction: 1, plate: { assetId: "v3", atMs: 4967 }, room: "pool" },
  ],
});
const quote = 2 + 3 + 2;
const body = { script, quotedCredits: quote, approved: true };
const request = (data: unknown, origin = "https://reelwalking.com") => new Request("https://reelwalking.com/api/reels/reel/script", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });
const ids = [0, 1, 2].map(index => scriptGenerationRequestId("w", scriptRequestKey(script.scriptId, index)));

beforeEach(() => {
  vi.clearAllMocks(); mocks.user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
  mocks.video = true; mocks.voice = true; mocks.lipsync = false;
  process.env.APP_URL = "https://reelwalking.com";
  mocks.findReel.mockResolvedValue({ id: "reel" }); mocks.findGenerations.mockResolvedValue([]); mocks.countGenerations.mockResolvedValue(0);
  mocks.balance.mockResolvedValue({ remaining: 20 }); mocks.wake.mockResolvedValue(undefined);
  let n = 0; mocks.generate.mockImplementation(async () => ({ id: `gen-${n++}` }));
});

describe("making a script's takes", () => {
  it("requires login, same origin, explicit approval and a reel of this workspace", async () => {
    mocks.user = null; expect((await make(request(body), params)).status).toBe(401);
    mocks.user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
    expect((await make(request(body, "https://other.invalid"), params)).status).toBe(403);
    expect((await make(request({ ...body, approved: false }), params)).status).toBe(400);
    mocks.findReel.mockResolvedValueOnce(null); expect((await make(request(body), params)).status).toBe(404);
    expect(mocks.findReel).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "reel", workspaceId: "w" } }));
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("refuses a quote that is not the script's, and a script the credits cannot finish", async () => {
    const wrong = await make(request({ ...body, quotedCredits: quote - 1 }), params);
    expect(wrong.status).toBe(409); expect((await wrong.json()).error).toMatch(/credit quote changed/);
    mocks.balance.mockResolvedValueOnce({ remaining: 6 });
    const short = await make(request(body), params);
    expect(short.status).toBe(409); expect((await short.json()).error).toBe("This script needs 7 more credits and 6 are left. Add credits in Account or shorten a line.");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("offers lip sync only when it is set up, and nothing when voices are not", async () => {
    expect((await make(request({ ...body, script: { ...script, voice: "lipsync" } }), params)).status).toBe(409);
    mocks.lipsync = true;
    expect((await make(request({ ...body, script: { ...script, voice: "lipsync" } }), params)).status).toBe(202);
    mocks.voice = false;
    expect((await make(request(body), params)).status).toBe(409);
    const info = await (await available(new Request("https://reelwalking.com/api/reels/reel/script"), params)).json();
    expect(info).toEqual({ enabled: false, voices: { veo: false, lipsync: false }, remaining: 0 });
  });

  it("sends the generation path the server's own prompts, exact, with stable request ids, two at a time", async () => {
    const response = await make(request({ ...body, script: { ...script, takes: script.takes.map(t => ({ ...t })) } }), params);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: [{ index: 0, id: "gen-0" }, { index: 1, id: "gen-1" }], waiting: [2], credits: quote, paused: "busy" });
    const expected = buildScriptShots(script, "reel");
    mocks.generate.mock.calls.forEach(([user, input, options], index) => {
      expect(user.workspaceId).toBe("w");
      expect(input).toEqual({ requestId: ids[index], prompt: expected[index].prompt, durationSeconds: expected[index].durationSeconds, shot: expected[index].shot });
      expect(options).toEqual({ exactPrompt: true });
      expect(z.string().uuid().safeParse(input.requestId).success).toBe(true);
    });
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  it("carries on from where it was when the same approval is sent again, never charging a take twice", async () => {
    mocks.findGenerations.mockResolvedValue([{ id: "gen-a", requestId: ids[0] }, { id: "gen-b", requestId: ids[1] }]);
    mocks.countGenerations.mockResolvedValue(1);
    // Only the last take is still owed: 2 credits, and 2 are left.
    mocks.balance.mockResolvedValue({ remaining: 2 });
    const response = await make(request(body), params);
    expect(await response.json()).toEqual({ started: [{ index: 0, id: "gen-a" }, { index: 1, id: "gen-b" }, { index: 2, id: "gen-0" }], waiting: [], credits: quote });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0][1].requestId).toBe(ids[2]);
  });

  it("waits rather than fails when another take took the last slot", async () => {
    mocks.generate.mockResolvedValueOnce({ id: "gen-x" }).mockRejectedValueOnce(new Error("Two clips are already generating. Wait for one to finish."));
    const response = await make(request(body), params);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: [{ index: 0, id: "gen-x" }], waiting: [1, 2], credits: quote, paused: "busy" });
  });

  it("pauses, not fails, at the hourly generation limit; a lost worker wake does not fail reserved takes", async () => {
    mocks.wake.mockRejectedValue(new Error("Worker wake lost"));
    mocks.generate.mockResolvedValueOnce({ id: "gen-x" }).mockRejectedValueOnce(new Error("You've reached the hourly generation limit. Please try again later."));
    const response = await make(request(body), params);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: [{ index: 0, id: "gen-x" }], waiting: [1, 2], credits: quote, paused: "hourly" });
    // Once paused for the hour, the rest are not tried this time.
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("refuses for good (409) when something else goes wrong, keeping what was started", async () => {
    mocks.generate.mockResolvedValueOnce({ id: "gen-x" }).mockRejectedValueOnce(new Error("That presenter is not in your workspace."));
    const response = await make(request(body), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "That presenter is not in your workspace.", started: [{ index: 0, id: "gen-x" }] });
  });

  it("refuses a generated take as a plate and a line over 20 words before anything is made", async () => {
    const aiPlate = await make(request({ ...body, script: { ...script, takes: [{ ...script.takes[0], plate: { assetId: "ai-1", atMs: 0 } }] } }), params);
    expect(aiPlate.status).toBe(400); expect((await aiPlate.json()).error).toMatch(/own footage/);
    const long = await make(request({ ...body, script: { ...script, takes: [{ ...script.takes[0], line: "word ".repeat(21) }] } }), params);
    expect(long.status).toBe(400); expect((await long.json()).error).toMatch(/20 words or fewer/);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("keeps request ids apart between workspaces, scripts and lines", () => {
    const other = "0b5e2f7a-9c1d-4e3f-8a2b-6c7d8e9f0a1b";
    expect(scriptGenerationRequestId("w", scriptRequestKey(script.scriptId, 0))).not.toBe(scriptGenerationRequestId("other", scriptRequestKey(script.scriptId, 0)));
    expect(scriptGenerationRequestId("w", scriptRequestKey(script.scriptId, 0))).not.toBe(scriptGenerationRequestId("w", scriptRequestKey(other, 0)));
    expect(new Set(ids).size).toBe(3);
  });
});

describe("a script's own takes", () => {
  const get = (query: string) => available(new Request(`https://reelwalking.com/api/reels/reel/script${query}`), params);
  it("returns exactly the script's generations, found by the request ids the server derives, however many others exist", async () => {
    mocks.findGenerations.mockResolvedValue([
      { id: "gen-b", requestId: ids[1], status: "RUNNING", error: null, failureCode: null, assetId: null },
      { id: "gen-a", requestId: ids[0], status: "SUCCEEDED", error: null, failureCode: null, assetId: "ai-gen-a" },
    ]);
    mocks.findAssets.mockResolvedValue([{ id: "ai-gen-a" }]);
    mocks.countGenerations.mockResolvedValue(1);
    const response = await get(`?scriptId=${script.scriptId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inFlight: 1, jobs: [
      { index: 1, id: "gen-b", status: "RUNNING", error: null, failureCode: null, asset: null },
      { index: 0, id: "gen-a", status: "SUCCEEDED", error: null, failureCode: null, asset: { id: "ai-gen-a", kind: "VIDEO", durationMs: 4000 } },
    ] });
    const where = mocks.findGenerations.mock.calls[0][0].where;
    expect(where.workspaceId).toBe("w");
    expect(where.requestId.in).toEqual([0, 1, 2, 3].map(index => scriptGenerationRequestId("w", scriptRequestKey(script.scriptId, index))));
    expect(mocks.findAssets.mock.calls[0][0].where).toEqual({ workspaceId: "w", id: { in: ["ai-gen-a"] } });
    // A take still being made keeps the worker awake.
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed script id and another workspace's reel", async () => {
    expect((await get("?scriptId=nope")).status).toBe(400);
    mocks.findReel.mockResolvedValueOnce(null);
    expect((await get(`?scriptId=${script.scriptId}`)).status).toBe(404);
    expect(mocks.findGenerations).not.toHaveBeenCalled();
  });
});
