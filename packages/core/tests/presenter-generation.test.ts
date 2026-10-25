import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAINED_REFERENCE_MESSAGE } from "../src/presenter";

const mocks = vi.hoisted(() => ({
  presenter: { findFirst: vi.fn() }, mediaAsset: { findFirst: vi.fn() }, aiGeneration: { findFirst: vi.fn() }, reel: { findFirst: vi.fn() },
  reserve: vi.fn(),
}));
// The workspace AI switch has its own tests (apps/web/lib/ai-off.test.ts); here every workspace has AI on.
vi.mock("@/lib/ai-gate", () => ({ aiOffResponse: async () => null, aiIsOff: async () => false, assertAiOn: async () => undefined, AI_OFF_MESSAGE: "off" }));
vi.mock("@reelwalk/db", () => ({ prisma: { presenter: mocks.presenter, mediaAsset: mocks.mediaAsset, aiGeneration: mocks.aiGeneration, reel: mocks.reel }, reserveAiGeneration: mocks.reserve, aiCreditSummary: vi.fn() }));
vi.mock("@/lib/quotas", () => ({ storageBlockedReason: async () => null }));
vi.mock("@/lib/workspace", () => ({ mediaScope: (workspaceId: string) => ({ OR: [{ workspaceId }, { shared: true }] }) }));
const aiVideoModule = "@/lib/ai-video";
const { createAiGeneration, presenterKit } = await import(aiVideoModule);

const user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
const scene = { id: "kitchen", kind: "IMAGE", contentType: "image/png", sizeBytes: 1000, objectKey: "uploads/w/kitchen.png", width: 1080, height: 1920 };
const first = "Beside the island bench, her waist just above it.";
const input = (compose: Record<string, unknown>) => ({ requestId: "5f0c6a52-7a2b-4c7e-9f00-0b7a4b0f3c11", prompt: "She turns to camera and smiles.", durationSeconds: 4,
  shot: { mode: "custom", first: { assetId: "kitchen", atMs: 0 }, compose: { first, framing: "medium", ...compose } } });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_VIDEO_ENABLED = "true"; process.env.GOOGLE_CLOUD_PROJECT = "p";
  mocks.reserve.mockImplementation(async (_db, data) => ({ id: "generation", ...data }));
  mocks.mediaAsset.findFirst.mockImplementation(async ({ where }) => where.id === "kitchen" ? scene : where.id === "body" ? { ...scene, id: "body", objectKey: "uploads/w/body.png" } : null);
});

describe("generation with a presenter kit (ADR 0056)", () => {
  it("resolves the kit inside the workspace only, and only once her face crop exists", async () => {
    await expect(presenterKit("w", "theirs")).rejects.toThrow("not in your workspace");
    expect(mocks.presenter.findFirst).toHaveBeenCalledWith({ where: { id: "theirs", workspaceId: "w" } });
    mocks.presenter.findFirst.mockResolvedValueOnce({ id: "kit", faceCropKey: null, faceCropError: null, fullBodyAssetId: "body" });
    await expect(presenterKit("w", "kit")).rejects.toThrow("still being prepared");
  });
  it("sends the kit's full-length still and face crop as the references, at depth 0", async () => {
    mocks.presenter.findFirst.mockResolvedValue({ id: "kit", faceCropKey: "workspaces/w/presenters/kit/portrait/claim-1.png", faceCropError: null, fullBodyAssetId: "body" });
    await createAiGeneration(user, input({ presenterId: "kit" }), { exactPrompt: true });
    const reserved = mocks.reserve.mock.calls[0][1];
    expect(reserved.frameSources).toEqual([
      { key: "uploads/w/body.png", kind: "IMAGE", atMs: 0, role: "presenter" },
      // The exact, immutable keys are snapshotted at reserve time: a later portrait change cannot alter them.
      { key: "workspaces/w/presenters/kit/portrait/claim-1.png", kind: "IMAGE", atMs: 0, role: "face" },
      { key: "uploads/w/kitchen.png", kind: "IMAGE", atMs: 0, role: "first", compose: first, framing: "medium" },
    ]);
    expect(reserved).toMatchObject({ presenterId: "kit", referenceDepth: 0 });
    // The full-length still must be this workspace's own image.
    expect(mocks.mediaAsset.findFirst).toHaveBeenCalledWith({ where: { id: "body", workspaceId: "w", kind: "IMAGE" } });
  });
  it("refuses a generated take as the reference, and records the chain depth when it is explicitly allowed", async () => {
    await expect(createAiGeneration(user, input({ presenter: { assetId: "ai-cmvgx1hlq", atMs: 0 } }), { exactPrompt: true })).rejects.toThrow(CHAINED_REFERENCE_MESSAGE);
    expect(mocks.reserve).not.toHaveBeenCalled();
    mocks.aiGeneration.findFirst.mockResolvedValue({ referenceDepth: 2 });
    mocks.mediaAsset.findFirst.mockImplementation(async ({ where }) => where.id === "kitchen" ? scene : where.id === "ai-cmvgx1hlq" ? { ...scene, id: "ai-cmvgx1hlq", kind: "VIDEO", contentType: "video/mp4", durationMs: 8000, objectKey: "workspaces/w/ai/x.mp4" } : null);
    await createAiGeneration(user, input({ presenter: { assetId: "ai-cmvgx1hlq", atMs: 0 }, allowGeneratedReference: true }), { exactPrompt: true });
    expect(mocks.aiGeneration.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { assetId: "ai-cmvgx1hlq", workspaceId: "w" } }));
    expect(mocks.reserve.mock.calls[0][1]).toMatchObject({ referenceDepth: 3, presenterId: undefined });
  });
});
