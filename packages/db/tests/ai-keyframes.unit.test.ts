import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient, AiKeyframe } from "../src/generated/prisma/client";
const lock = vi.hoisted(() => vi.fn());
vi.mock("../src/ai-credits", () => ({ lockBillingAccount: lock, AiCreditError: class extends Error {} }));
vi.mock("../src/keyframe-storage", () => ({ keyframeStorageTransaction: (db: PrismaClient, _ids: string[], callback: Parameters<PrismaClient["$transaction"]>[0]) => db.$transaction(callback as never) }));
import { reserveKeyframe, assertSameKeyframe, makeKeyframeRequest, keyframeHash, refundRefusedKeyframe, type KeyframeSnapshot } from "../src/ai-keyframes";
const input = { role: "end" as const, source: { assetId: "photo", atMs: 0 as const }, move: "shift-right" as const, distanceM: 3, durationSeconds: 4 as const };
const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
const request = makeKeyframeRequest(input, png);
const snapshot: KeyframeSnapshot = { model: "gemini-3-pro-image", source: { assetId: "photo", objectKey: "photo.png", originalHash: "original", canonicalKey: "private.png", canonicalHash: keyframeHash(png) }, requestKey: "request.json", price: { inputPerMillion: 2, outputPerMillion: 120, inputTokenBound: 8192, outputTokenBound: 8192, maximumUsdMicros: 999424, evidence: "https://cloud.google.com/model-garden/pricing/" } };
const value = { requestId: "4ec2359d-c4af-490b-b5ec-36a88f499605", input, inputHash: keyframeHash(JSON.stringify(input)), requestHash: keyframeHash(request), snapshot };
function fixture() {
  const tx = { user: { findFirst: vi.fn().mockResolvedValue({ id: "u" }) }, mediaAsset: { findFirst: vi.fn().mockResolvedValue({ id: "photo" }) },
    aiKeyframe: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0), create: vi.fn().mockImplementation(async ({ data }) => ({ id: "job", ...data })) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "grant", remaining: 2 }]), $executeRaw: vi.fn(),
    aiSpendBudget: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, aiCreditGrant: { update: vi.fn() } };
  const db = { $transaction: vi.fn(async (fn: (db: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaClient;
  return { tx, db };
}
beforeEach(() => { process.env.AI_KEYFRAMES_ENABLED = "true"; process.env.GOOGLE_CLOUD_PROJECT = "fixture"; lock.mockResolvedValue({ aiGeneration: "on" }); });
describe("image reservation", () => {
  it("refunds a conclusive refusal under the shared billing lock exactly once across concurrent collection", async () => {
    const row = { id: "job", workspaceId: "w", grantId: "original", status: "UNKNOWN", creditRefunded: false, submittedAt: new Date(), responseKey: "receipt", responseHash: "hash", heldCostCents: 100 };
    const update = vi.fn(async ({ where, data }) => { if (!where.status.in.includes(row.status) || row.creditRefunded !== where.creditRefunded) return { count: 0 }; Object.assign(row, data); return { count: 1 }; });
    const tx = { $queryRaw: vi.fn(), aiKeyframe: { findUniqueOrThrow: vi.fn(async () => ({ ...row })), updateMany: update }, aiCreditGrant: { update: vi.fn() }, aiSpendBudget: { update: vi.fn() } };
    const db = { $transaction: vi.fn(async (fn: (db: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaClient;
    await Promise.all([refundRefusedKeyframe(db, "job", 400), refundRefusedKeyframe(db, "job", 400)]);
    await refundRefusedKeyframe(db, "job", 400);
    expect(tx.$queryRaw.mock.calls[0][0].join(" ")).toContain('FROM "Workspace"');
    expect(tx.aiKeyframe.updateMany.mock.calls[0][0].where).toMatchObject({ submittedAt: { not: null }, responseKey: { not: null }, responseHash: { not: null }, creditRefunded: false });
    expect(tx.aiCreditGrant.update).toHaveBeenCalledTimes(1); expect(tx.aiCreditGrant.update).toHaveBeenCalledWith({ where: { id: "original" }, data: { remaining: { increment: 1 } } });
    expect(row.status).toBe("FAILED"); expect(row.creditRefunded).toBe(true); expect(row.heldCostCents).toBe(100); expect(tx.aiSpendBudget.update).not.toHaveBeenCalled();
    await expect(refundRefusedKeyframe(db, "job", 200)).rejects.toThrow("definitive HTTP refusal");
  });
  it("reserves a whole dollar and one existing credit together before queuing", async () => {
    const { tx, db } = fixture();
    await reserveKeyframe(db, { id: "u", workspaceId: "w" }, value);
    expect(tx.aiSpendBudget.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "vertex-video", reservedCents: { lte: 23900 } }, data: { reservedCents: { increment: 100 } } }));
    expect(tx.aiCreditGrant.update).toHaveBeenCalledWith({ where: { id: "grant" }, data: { remaining: { decrement: 1 } } });
    expect(tx.aiKeyframe.create).toHaveBeenCalledWith({ data: expect.objectContaining({ requestHash: value.requestHash, inputHash: value.inputHash }) });
  });
  it.each(["paused", "queue", "credits", "budget", "access"])("retains no inputs when admission fails for %s", async reason => {
    const { tx, db } = fixture(); const persist = vi.fn();
    if (reason === "paused") lock.mockResolvedValue({ aiGeneration: "off" });
    if (reason === "queue") tx.aiKeyframe.count.mockResolvedValue(4);
    if (reason === "credits") tx.$queryRaw.mockResolvedValue([]);
    if (reason === "budget") tx.aiSpendBudget.updateMany.mockResolvedValue({ count: 0 });
    if (reason === "access") tx.user.findFirst.mockResolvedValue(null);
    await expect(reserveKeyframe(db, { id: "u", workspaceId: "w" }, value, new Date(), persist)).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled(); expect(tx.aiKeyframe.create).not.toHaveBeenCalled();
  });
  it("persists only admitted inputs before exposing a job, and never repeats persistence for the same request", async () => {
    const { tx, db } = fixture();
    const persist = vi.fn(async () => {
      expect(tx.aiCreditGrant.update).toHaveBeenCalledOnce();
      expect(tx.aiSpendBudget.updateMany).toHaveBeenCalledOnce();
      expect(tx.aiKeyframe.create).not.toHaveBeenCalled();
    });
    const row = await reserveKeyframe(db, { id: "u", workspaceId: "w" }, value, new Date(), persist);
    tx.aiKeyframe.findUnique.mockResolvedValue(row as AiKeyframe);
    await reserveKeyframe(db, { id: "u", workspaceId: "w" }, value, new Date(), persist);
    expect(persist).toHaveBeenCalledOnce(); expect(tx.aiKeyframe.create).toHaveBeenCalledOnce();
  });
  it("does not expose a queued job if retaining its inputs fails", async () => {
    const { tx, db } = fixture();
    await expect(reserveKeyframe(db, { id: "u", workspaceId: "w" }, value, new Date(), async () => { throw Error("storage unavailable"); })).rejects.toThrow("storage unavailable");
    expect(tx.aiKeyframe.create).not.toHaveBeenCalled();
  });
  it("refuses unavailable foreign source before budget or credit writes", async () => {
    const { tx, db } = fixture(); tx.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(reserveKeyframe(db, { id: "u", workspaceId: "w" }, value)).rejects.toThrow("source photo changed");
    expect(tx.mediaAsset.findFirst.mock.calls[0][0].where).toMatchObject({ id: "photo", OR: [{ workspaceId: "w" }, { shared: true }] });
    expect(tx.aiSpendBudget.updateMany).not.toHaveBeenCalled(); expect(tx.aiCreditGrant.update).not.toHaveBeenCalled();
  });
  it("does not debit when shared budget is exhausted", async () => {
    const { tx, db } = fixture(); tx.aiSpendBudget.updateMany.mockResolvedValue({ count: 0 });
    await expect(reserveKeyframe(db, { id: "u", workspaceId: "w" }, value)).rejects.toThrow("No credits used");
    expect(tx.aiCreditGrant.update).not.toHaveBeenCalled(); expect(tx.aiKeyframe.create).not.toHaveBeenCalled();
  });
  it("returns only the identical request and rejects source, direction or pixel changes", async () => {
    const { tx, db } = fixture(); tx.aiKeyframe.findUnique.mockResolvedValue({ id: "old", inputHash: value.inputHash, requestHash: value.requestHash } as AiKeyframe);
    expect((await reserveKeyframe(db, { id: "u", workspaceId: "w" }, value)).id).toBe("old");
    expect(tx.aiSpendBudget.updateMany).not.toHaveBeenCalled();
    for (const changed of [{ ...input, move: "rise" }, { ...input, source: { assetId: "other", atMs: 0 } }]) expect(() => assertSameKeyframe(value, keyframeHash(JSON.stringify(changed)), value.requestHash)).toThrow("different frames");
    expect(() => assertSameKeyframe(value, value.inputHash, "changed-pixels")).toThrow("different frames");
  });
  it("fixes a single bounded Pro image request, without accepting arbitrary endpoints", () => {
    expect(JSON.parse(request).generationConfig).toEqual({ candidateCount: 1, responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "9:16", imageSize: "2K" }, maxOutputTokens: 8192 });
    expect(() => makeKeyframeRequest(input, Buffer.from("not png"))).toThrow("bounded image");
  });
});
