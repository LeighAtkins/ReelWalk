import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_DRAFT_MODEL, AI_VIDEO_MODEL, MOVES, aiClipCostCents, aiDraftCostCents, movePrompt } from "../src";

// ADR 0076: a move and a draft ride on the ordinary generation request; "Make it final" reads everything from the draft.
const mocks = vi.hoisted(() => ({ mediaAsset: { findFirst: vi.fn() }, aiGeneration: { findFirst: vi.fn() }, reel: { findFirst: vi.fn() }, reserve: vi.fn() }));
// The workspace AI switch has its own tests (apps/web/lib/ai-off.test.ts); here every workspace has AI on.
vi.mock("@/lib/ai-gate", () => ({ aiOffResponse: async () => null, aiIsOff: async () => false, assertAiOn: async () => undefined, AI_OFF_MESSAGE: "off" }));
vi.mock("@reelwalk/db", () => ({ prisma: { mediaAsset: mocks.mediaAsset, aiGeneration: mocks.aiGeneration, reel: mocks.reel, presenter: { findFirst: vi.fn() } }, reserveAiGeneration: mocks.reserve, aiCreditSummary: vi.fn() }));
vi.mock("@/lib/quotas", () => ({ storageBlockedReason: async () => null }));
vi.mock("@/lib/workspace", () => ({ mediaScope: (workspaceId: string) => ({ OR: [{ workspaceId }, { shared: true }] }) }));
const aiVideoModule = "@/lib/ai-video";
const { createAiGeneration, generationInput } = await import(aiVideoModule);
const movesRoute = "@/app/api/moves/route";
const { GET: listMoves } = await import(movesRoute);

const user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
const photo = { id: "kitchen", kind: "IMAGE", contentType: "image/jpeg", sizeBytes: 1000, objectKey: "uploads/w/kitchen.jpg", width: 1080, height: 1920 };
const requestId = "5f0c6a52-7a2b-4c7e-9f00-0b7a4b0f3c11";
const request = (extra: Record<string, unknown> = {}) => ({ requestId, prompt: movePrompt("orbit"), durationSeconds: 8, shot: { mode: "custom", first: { assetId: "kitchen", atMs: 0 } }, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_VIDEO_ENABLED = "true"; process.env.GOOGLE_CLOUD_PROJECT = "p"; delete process.env.VOICE_ENABLED;
  mocks.reserve.mockImplementation(async (_db, data) => ({ id: "generation", ...data }));
  mocks.mediaAsset.findFirst.mockImplementation(async ({ where }) => where.id === "kitchen" ? photo : null);
});

describe("a camera move on a generation request", () => {
  it("is stored on the shot and replaces the shot type's camera sentence in the prompt Veo gets", async () => {
    await createAiGeneration(user, generationInput.parse(request({ move: "dolly-zoom", prompt: "A bright living room." })));
    const reserved = mocks.reserve.mock.calls[0][1];
    expect(reserved.shot).toMatchObject({ mode: "custom", move: "dolly-zoom" });
    expect(reserved.prompt).toContain("vertigo effect");
    expect(reserved.prompt).toContain("A bright living room.");
    expect(reserved.model).toBe(AI_VIDEO_MODEL);
    expect(reserved).not.toHaveProperty("tier");
    expect(reserved.durationSeconds).toBe(8);
  });

  it("sizes the take from the move when no length is asked, and refuses a move that does not exist", async () => {
    await createAiGeneration(user, generationInput.parse({ ...request({ move: "fpv-fly-through" }), durationSeconds: undefined }));
    expect(mocks.reserve.mock.calls[0][1].durationSeconds).toBe(8);
    expect(generationInput.safeParse(request({ move: "barrel-roll" })).success).toBe(false);
  });

  it("works with no shot at all: words and a move", async () => {
    await createAiGeneration(user, generationInput.parse({ requestId, prompt: "A modern kitchen, morning light.", move: "crane-down" }));
    const reserved = mocks.reserve.mock.calls[0][1];
    expect(reserved.shot).toMatchObject({ mode: "custom", move: "crane-down" });
    expect(reserved.prompt).toContain("crane-down");
    expect(reserved.frameSources).toBeUndefined();
  });

  it("knows every move in the table over HTTP, with the AI-only ones marked", async () => {
    const body = await (listMoves() as Response).json();
    expect(body.moves).toHaveLength(MOVES.length);
    const byId = Object.fromEntries(body.moves.map((m: { id: string }) => [m.id, m]));
    expect(byId["dolly-zoom"]).toMatchObject({ aiOnly: true, real: null });
    expect(byId["crash-zoom"]).toMatchObject({ aiOnly: false, real: { speedRamp: "hit" } });
    expect(byId["crash-zoom"].ai.prompt).toBe(movePrompt("crash-zoom"));
    expect(body.draft).toMatchObject({ model: AI_DRAFT_MODEL, credits: 1 });
  });
});

describe("draft generations", () => {
  it("run on the Lite model, reserve a draft's cost, and carry a seed and the tier on the shot", async () => {
    await createAiGeneration(user, generationInput.parse(request({ quality: "draft", move: "orbit" })));
    const reserved = mocks.reserve.mock.calls[0][1];
    expect(reserved).toMatchObject({ model: AI_DRAFT_MODEL, durationSeconds: 8, costCents: aiDraftCostCents(8), tier: "draft", voiced: false });
    expect(reserved.costCents).toBeLessThan(aiClipCostCents(8));
    expect(reserved.shot.tier).toBe("draft");
    expect(Number.isInteger(reserved.shot.seed)).toBe(true);
    expect(reserved.shot.seed).toBeGreaterThan(0);
    expect(reserved.shot.seed).toBeLessThan(2 ** 32);
  });

  it("keeps a seed the caller brought, and does not charge or require the voice for a draft", async () => {
    const shot = { mode: "custom", first: { assetId: "kitchen", atMs: 0 }, seed: 1234, line: "Welcome home.", voice: "lipsync" };
    await createAiGeneration(user, generationInput.parse(request({ quality: "draft", shot })));
    const reserved = mocks.reserve.mock.calls[0][1];
    expect(reserved.shot).toMatchObject({ seed: 1234, voice: "lipsync", line: "Welcome home." });
    expect(reserved.voiced).toBe(false);
  });

  it("refuses an ending frame (Lite takes none) before anything is reserved, and leaves a full take's price alone", async () => {
    const shot = { mode: "custom", first: { assetId: "kitchen", atMs: 0 }, last: { assetId: "kitchen", atMs: 0 } };
    await expect(createAiGeneration(user, generationInput.parse(request({ quality: "draft", shot })))).rejects.toThrow("starting frame only");
    expect(mocks.reserve).not.toHaveBeenCalled();
    await createAiGeneration(user, generationInput.parse(request({ shot })));
    expect(mocks.reserve.mock.calls[0][1]).toMatchObject({ model: AI_VIDEO_MODEL, costCents: aiClipCostCents(8) });
  });

  it("does not auto-assemble a promo reel from a low-resolution preview", async () => {
    mocks.reel.findFirst.mockResolvedValue({ id: "reel" });
    const shot = { mode: "custom", first: { assetId: "kitchen", atMs: 0 }, draftReelId: "reel" };
    await createAiGeneration(user, generationInput.parse(request({ quality: "draft", shot })));
    expect(mocks.reserve.mock.calls[0][1].shot.draftReelId).toBeUndefined();
  });
});

describe("Make it final", () => {
  const draftRow = (shot: Record<string, unknown> = {}) => ({
    id: "draft-1", workspaceId: "w", status: "SUCCEEDED", prompt: "The exact prompt Veo was given for the draft.", durationSeconds: 8, credits: 1,
    frameSources: [{ key: "uploads/w/kitchen.jpg", kind: "IMAGE", atMs: 0, role: "first" }], referenceKey: null, referenceType: null, presenterId: "kit", referenceDepth: 0,
    shot: { mode: "custom", move: "orbit", first: { assetId: "kitchen", atMs: 0 }, tier: "draft", seed: 4242, ...shot },
  });

  it("asks the full model for the draft's own prompt, frames, presenter and seed, naming the draft whose credit it uses", async () => {
    mocks.aiGeneration.findFirst.mockResolvedValue(draftRow());
    await createAiGeneration(user, generationInput.parse({ requestId, prompt: "Make it final now.", finalOf: "draft-1" }));
    expect(mocks.aiGeneration.findFirst).toHaveBeenCalledWith({ where: { id: "draft-1", workspaceId: "w", status: "SUCCEEDED" } });
    const reserved = mocks.reserve.mock.calls[0][1];
    expect(reserved).toMatchObject({
      model: AI_VIDEO_MODEL, durationSeconds: 8, costCents: aiClipCostCents(8), tier: "final", finalOf: "draft-1", presenterId: "kit", referenceDepth: 0,
      prompt: "The exact prompt Veo was given for the draft.", frameSources: [{ key: "uploads/w/kitchen.jpg", kind: "IMAGE", atMs: 0, role: "first" }],
    });
    expect(reserved.shot).toMatchObject({ move: "orbit", tier: "final", finalOf: "draft-1", seed: 4242 });
  });

  it("charges the voice with the final when the draft held the line", async () => {
    process.env.VOICE_ENABLED = "true";
    mocks.aiGeneration.findFirst.mockResolvedValue(draftRow({ line: "Welcome home.", voice: "veo" }));
    await createAiGeneration(user, generationInput.parse({ requestId, prompt: "Make it final now.", finalOf: "draft-1" }));
    expect(mocks.reserve.mock.calls[0][1]).toMatchObject({ voiced: true, costCents: aiClipCostCents(8, true) });
  });

  it("refuses a draft that is not finished, not a draft, or not this workspace's, without reserving", async () => {
    mocks.aiGeneration.findFirst.mockResolvedValue(null);
    await expect(createAiGeneration(user, generationInput.parse({ requestId, prompt: "Make it final now.", finalOf: "theirs" }))).rejects.toThrow("finished draft");
    mocks.aiGeneration.findFirst.mockResolvedValue(draftRow({ tier: "final" }));
    await expect(createAiGeneration(user, generationInput.parse({ requestId, prompt: "Make it final now.", finalOf: "draft-1" }))).rejects.toThrow("finished draft");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
