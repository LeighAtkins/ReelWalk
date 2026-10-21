import { beforeEach, describe, expect, it, vi } from "vitest";
import { directorPlanSchema } from "../src/ai-director";
import { CHAINED_REFERENCE_MESSAGE } from "../src/presenter";

const mocks = vi.hoisted(() => ({
  user: { id: "u", workspaceId: "w", email: "owner@test.invalid" } as { id: string; workspaceId: string; email: string } | null,
  presenter: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  mediaAsset: { findFirst: vi.fn() }, aiEdit: { findFirst: vi.fn(), findMany: vi.fn() }, aiGeneration: { findMany: vi.fn() },
  generate: vi.fn(), wake: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => mocks.user }));
vi.mock("@reelwalk/db", () => ({ prisma: {
  presenter: mocks.presenter, mediaAsset: mocks.mediaAsset, aiEdit: mocks.aiEdit, aiGeneration: mocks.aiGeneration,
  $transaction: async (fn: (tx: unknown) => unknown) => fn({ presenter: mocks.presenter }),
} }));
vi.mock("@/lib/ai-video", () => ({ createAiGeneration: mocks.generate }));
vi.mock("@/lib/render-capacity", () => ({ ensureWorkerRunning: mocks.wake }));
// Web routes are compiled by the web workspace; load them under Vitest's web aliases here.
const presentersModule = "@/app/api/presenters/route", presenterModule = "@/app/api/presenters/[id]/route", approvalModule = "@/app/api/reels/[id]/director/generate/route";
const { GET: list, POST: create } = await import(presentersModule);
const { PATCH: update } = await import(presenterModule);
const { POST: approve } = await import(approvalModule);

const request = (url: string, method: string, data?: unknown, origin = "https://reelwalking.com") => new Request(`https://reelwalking.com${url}`, { method, headers: { origin, "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const row = (extra: Record<string, unknown> = {}) => ({ id: "kit", workspaceId: "w", name: "Maya", portraitAssetId: "portrait", fullBodyAssetId: "body", voice: null, isDefault: true, faceCropKey: null, faceCropError: null, faceHeightPx: null, createdAt: new Date("2026-10-21T00:00:00Z"), ...extra });
const kitInput = { name: "Maya", portraitAssetId: "portrait", fullBodyAssetId: "body" };

beforeEach(() => {
  vi.clearAllMocks(); mocks.user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
  process.env.APP_URL = "https://reelwalking.com";
  mocks.mediaAsset.findFirst.mockResolvedValue({ id: "portrait", sizeBytes: 300_000, height: 1672 });
  mocks.presenter.count.mockResolvedValue(0); mocks.presenter.findFirst.mockResolvedValue(null);
  mocks.presenter.create.mockImplementation(async ({ data }) => row(data)); mocks.presenter.update.mockImplementation(async ({ data }) => row(data));
  mocks.generate.mockResolvedValue({ id: "generation" }); mocks.wake.mockResolvedValue(undefined);
});

describe("presenter kits API (ADR 0056)", () => {
  it("requires login and same origin", async () => {
    mocks.user = null;
    expect((await list()).status).toBe(401);
    expect((await create(request("/api/presenters", "POST", kitInput))).status).toBe(401);
    mocks.user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
    expect((await create(request("/api/presenters", "POST", kitInput, "https://other.invalid"))).status).toBe(403);
    expect(mocks.presenter.create).not.toHaveBeenCalled();
  });
  it("lists only this workspace's kits", async () => {
    mocks.presenter.findMany.mockResolvedValue([row({ faceCropKey: "face.png", faceHeightPx: 450 })]);
    const response = await list();
    expect(mocks.presenter.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w" } }));
    expect((await response.json()).presenters[0]).toMatchObject({ id: "kit", ready: true, status: "Ready" });
  });
  it("accepts only the workspace's own JPEG/PNG uploads as the kit's photos", async () => {
    mocks.mediaAsset.findFirst.mockResolvedValueOnce(null);
    const refused = await create(request("/api/presenters", "POST", kitInput));
    expect(refused.status).toBe(400);
    expect(mocks.mediaAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "portrait", workspaceId: "w", shared: false, kind: "IMAGE" }) }));
    expect((await create(request("/api/presenters", "POST", { ...kitInput, fullBodyAssetId: "ai-take" }))).status).toBe(400);
    expect(mocks.presenter.create).not.toHaveBeenCalled();
  });
  it("creates the first kit as the default and wakes the worker for the face crop", async () => {
    const response = await create(request("/api/presenters", "POST", kitInput));
    expect(response.status).toBe(201);
    expect(mocks.presenter.create).toHaveBeenCalledWith({ data: expect.objectContaining({ workspaceId: "w", isDefault: true, portraitAssetId: "portrait" }) });
    expect((await response.json()).presenter).toMatchObject({ ready: false, status: "Preparing her face reference…" });
    expect(mocks.wake).toHaveBeenCalled();
  });
  it("changes only a kit in this workspace, and a new portrait resets the face crop", async () => {
    const missing = await update(request("/api/presenters/kit", "PATCH", { name: "M" }), { params: Promise.resolve({ id: "kit" }) });
    expect(missing.status).toBe(404);
    expect(mocks.presenter.findFirst).toHaveBeenCalledWith({ where: { id: "kit", workspaceId: "w" } });
    mocks.presenter.findFirst.mockResolvedValue(row({ faceCropKey: "old.png" }));
    await update(request("/api/presenters/kit", "PATCH", { portraitAssetId: "closer", isDefault: true }), { params: Promise.resolve({ id: "kit" }) });
    expect(mocks.presenter.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "w", isDefault: true, id: { not: "kit" } }, data: { isDefault: false } });
    expect(mocks.presenter.update).toHaveBeenCalledWith({ where: { id: "kit" }, data: expect.objectContaining({ portraitAssetId: "closer", faceCropKey: null, faceCropTries: 0 }) });
  });
});

describe("Opus approvals use the presenter kit", () => {
  const checks = Object.fromEntries(["scale", "cameraContinuity", "presenterContinuity", "propertyIdentity"].map(k => [k, { result: "uncertain", evidence: "Sampled frames only" }]));
  const plan = (presenter: unknown) => directorPlanSchema.parse({ note: "Bring her in", verdict: "needs-generation", issues: [], limitations: "Sampled frames only", checks,
    edit: { ops: [], note: "", questions: [], caption: null },
    shots: [{ title: "Welcome", reason: "Face the camera", prompt: "She turns to camera in the kitchen and smiles, smooth gimbal motion, no cuts.", durationSeconds: 4,
      first: { assetId: "kitchen", atMs: 0 }, last: null, compose: { presenter, first: "Beside the island bench, her waist just above it.", last: null, framing: null }, line: null, voice: null }] });
  const body = { editId: "edit", index: 0, quotedCredits: 1, approved: true };
  const params = { params: Promise.resolve({ id: "reel" }) };
  const approveWith = async (presenter: unknown, extra: Record<string, unknown> = {}) => {
    mocks.aiEdit.findFirst.mockResolvedValue({ model: "claude-opus-5-5", plan: { kind: "director", plan: plan(presenter) } });
    return approve(request("/api/reels/reel/director/generate", "POST", { ...body, ...extra }), params);
  };
  it("uses the workspace's default kit even when Opus named a generated take", async () => {
    mocks.presenter.findFirst.mockResolvedValue({ id: "kit" });
    expect((await approveWith({ assetId: "ai-cmvgx1hlq", atMs: 0 })).status).toBe(202);
    expect(mocks.presenter.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", isDefault: true } }));
    expect(mocks.generate.mock.calls[0][1].shot.compose).toEqual({ presenterId: "kit", first: "Beside the island bench, her waist just above it.", framing: "medium" });
  });
  it("uses the kit the studio picked", async () => {
    expect((await approveWith(null, { presenterId: "picked" })).status).toBe(202);
    expect(mocks.generate.mock.calls[0][1].shot.compose.presenterId).toBe("picked");
  });
  it("refuses a chained reference without a kit unless it is explicitly allowed", async () => {
    const refused = await approveWith({ assetId: "ai-cmvgx1hlq", atMs: 0 });
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: CHAINED_REFERENCE_MESSAGE });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect((await approveWith({ assetId: "ai-cmvgx1hlq", atMs: 0 }, { allowGeneratedReference: true })).status).toBe(202);
    expect(mocks.generate.mock.calls[0][1].shot.compose).toMatchObject({ presenter: { assetId: "ai-cmvgx1hlq", atMs: 0 }, allowGeneratedReference: true });
  });
  it("asks for a presenter when Opus left it to the kit and there is none", async () => {
    const response = await approveWith(null);
    expect(response.status).toBe(409); expect((await response.json()).error).toContain("Set up a presenter");
  });
});
