import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { cameraKeyframeGenerateSchema } from "@reelwalk/core";
const mocks = vi.hoisted(() => ({ db: { aiKeyframe: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() }, mediaAsset: { findFirst: vi.fn(), create: vi.fn() }, $transaction: vi.fn() }, read: vi.fn(), put: vi.fn(), reserve: vi.fn() }));
vi.mock("@reelwalk/db", async importOriginal => ({ ...await importOriginal<typeof import("@reelwalk/db")>(), prisma: mocks.db, reserveKeyframe: mocks.reserve }));
vi.mock("./storage", () => ({ readKeyframeObject: mocks.read, putKeyframeObject: mocks.put }));
vi.mock("./quotas", () => ({ storageBlockedReason: async () => null }));
vi.mock("./library", () => ({ toLibraryAsset: async (asset: object) => asset }));
import { generateKeyframe, keyframeArtifact, useKeyframe } from "./ai-keyframes";
import { keyframeHash } from "@reelwalk/db";
const actor = { id: "u", workspaceId: "w", email: "owner@fixture.invalid" };
const input = { action: "generate" as const, requestId: "4ec2359d-c4af-490b-b5ec-36a88f499605", role: "end" as const, source: { assetId: "photo", atMs: 0 as const }, move: "shift-right" as const, distanceM: 3, durationSeconds: 4 as const };
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("AI_KEYFRAMES_ENABLED", "true"); vi.stubEnv("GOOGLE_CLOUD_PROJECT", "fixture"); });
describe("owned keyframe candidates", () => {
  it("returns an existing saved request without re-reading changed sources, retaining objects or admitting it again", async () => {
    const frozen = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).strip().parse(input);
    const row = { id: "saved", requestId: input.requestId, workspaceId: "w", input: frozen, inputHash: keyframeHash(JSON.stringify(frozen)), snapshot: { source: {} }, status: "QUEUED", createdAt: new Date() };
    mocks.db.aiKeyframe.findUnique.mockResolvedValue(row);
    vi.stubEnv("AI_KEYFRAMES_ENABLED", "false");
    expect((await generateKeyframe(actor, input)).id).toBe("saved");
    expect(mocks.db.aiKeyframe.findUnique).toHaveBeenCalledWith({ where: { workspaceId_requestId: { workspaceId: "w", requestId: input.requestId } } });
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
    await expect(generateKeyframe(actor, { ...input, move: "shift-left" })).rejects.toThrow("different frames");
  });
  it("does not write private images or request JSON before the reservation admits them", async () => {
    mocks.db.mediaAsset.findFirst.mockResolvedValue({ objectKey: "photo.png", contentType: "image/png", sizeBytes: 100n });
    mocks.read.mockResolvedValue(await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer());
    mocks.reserve.mockImplementation(async (_db, _actor, value, _now, persist) => {
      expect(mocks.put).not.toHaveBeenCalled();
      await persist();
      expect(mocks.put).toHaveBeenCalledTimes(2);
      return { ...value, id: "new", workspaceId: "w", status: "QUEUED", createdAt: new Date() };
    });
    expect((await generateKeyframe(actor, input)).id).toBe("new");
    mocks.put.mockClear(); mocks.reserve.mockRejectedValue(new Error("admission denied"));
    await expect(generateKeyframe(actor, input)).rejects.toThrow("admission denied");
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("rejects a foreign photo before creating a reservation or provider work", async () => {
    mocks.db.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(generateKeyframe(actor, input)).rejects.toThrow("from your library");
    expect(mocks.db.mediaAsset.findFirst.mock.calls[0][0].where).toMatchObject({ id: "photo", OR: [{ workspaceId: "w" }, { shared: true }] });
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled();
  });
  it("serves only workspace-owned frozen comparison pixels and rejects stale hashes", async () => {
    mocks.db.aiKeyframe.findFirst.mockResolvedValue({ snapshot: { source: { canonicalKey: "source", canonicalHash: keyframeHash("frozen") } } });
    mocks.read.mockResolvedValue(Buffer.from("frozen"));
    expect((await keyframeArtifact(actor, "job", "source")).bytes.toString()).toBe("frozen");
    expect(mocks.db.aiKeyframe.findFirst.mock.calls[0][0]).toEqual({ where: { id: "job", workspaceId: "w" } });
    mocks.read.mockResolvedValue(Buffer.from("different"));
    await expect(keyframeArtifact(actor, "job", "source")).rejects.toThrow("pixels changed");
    mocks.db.aiKeyframe.findFirst.mockResolvedValue(null);
    await expect(keyframeArtifact(actor, "foreign", "candidate")).rejects.toThrow("unavailable");
  });
  it("creates exactly one owned media asset only on explicit Use, without changing a reel or invoking Veo", async () => {
    const bytes = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "white" } }).jpeg().toBuffer();
    const row = { id: "job", workspaceId: "w", requestId: input.requestId, input, snapshot: { source: { canonicalKey: "source" } }, status: "CANDIDATE", candidateKey: "candidate.jpg", candidateHash: keyframeHash(bytes), heldCostCents: 100, createdAt: new Date() };
    const tx = { $queryRaw: vi.fn(), aiKeyframe: { findFirst: vi.fn(async ({ where }) => where.workspaceId === row.workspaceId ? row : null), update: vi.fn(async ({ data }) => Object.assign(row, data)) }, mediaAsset: { create: mocks.db.mediaAsset.create } };
    mocks.db.$transaction.mockImplementation(async fn => fn(tx)); mocks.read.mockResolvedValue(bytes);
    mocks.db.mediaAsset.create.mockResolvedValue({ id: "owned", objectKey: "candidate.jpg", workspaceId: "w", kind: "IMAGE" });
    mocks.db.mediaAsset.findFirst.mockResolvedValue({ id: "owned", kind: "IMAGE", workspaceId: "w" });
    expect(mocks.db.mediaAsset.create).not.toHaveBeenCalled();
    const used = await useKeyframe(actor, "job");
    expect(used.asset.id).toBe("owned"); expect(used.job.status).toBe("USED");
    expect(mocks.db.mediaAsset.create).toHaveBeenCalledWith({ data: expect.objectContaining({ objectKey: "candidate.jpg", workspaceId: "w", width: 1080, height: 1920, shared: false, attribution: expect.stringContaining("approximate camera intent") }) });
    await useKeyframe(actor, "job"); expect(mocks.db.mediaAsset.create).toHaveBeenCalledTimes(1); expect(mocks.reserve).not.toHaveBeenCalled();
    await expect(useKeyframe({ ...actor, workspaceId: "foreign" }, "job")).rejects.toThrow("from this workspace");
  });
});
