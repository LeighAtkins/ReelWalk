import { createAiGeneration } from "./ai-video";
vi.mock("@reelwalk/db", async importOriginal => ({ ...await importOriginal<typeof import("@reelwalk/db")>(), reserveAiGeneration: vi.fn(async (_db, input) => input) }));
vi.mock("./ai-gate", () => ({ assertAiOn: vi.fn() }));
vi.mock("./quotas", () => ({ storageBlockedReason: vi.fn(async () => null) }));
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { aiFrames } from "../../worker/src/ai-frames";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execute }));
vi.mock("node:util", () => ({ promisify: () => execute }));
import { aiShotSchema, furnitureStagePixels } from "@reelwalk/core";
import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { prisma, reserveAiGeneration, keyframeHash } from "@reelwalk/db";
import { adjustFurnitureArea, furnitureAdjustmentServices, furnitureDerivativeKeyframe } from "./furniture-adjustment";
import { finalFurnitureImage } from "./furniture-receipt";
const actor = { id: "owner", workspaceId: "workspace" };
const region = { x: 0, y: 1017 / 1920, width: 520 / 1080, height: 223 / 1920 };
async function fixture() {
  const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
  const receipt = Buffer.from(JSON.stringify({ version: 1, status: 200, bodyBase64: Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: "image/png", data: "ignored" } }, { inlineData: { mimeType: "image/png", data: image.toString("base64") } }] } }] })).toString("base64") }));
  const job = { id: "job", responseKey: "response", responseHash: keyframeHash(receipt), input: { source: { assetId: "original" }, furnitureStage: { version: 1, style: "warm-minimal", instructions: "", region } }, snapshot: { source: { canonicalKey: "source", canonicalHash: keyframeHash(image) } } };
  const objects = new Map<string, Buffer>();
  let saved: unknown;
  const db = { user: { findFirst: vi.fn(async () => ({ id: actor.id })) }, aiKeyframe: { findFirst: vi.fn(async ({ where }: { where: { workspaceId: string } }) => where.workspaceId === actor.workspaceId ? job : null) }, $queryRaw: vi.fn(), mediaAsset: { findFirst: vi.fn(async () => saved), create: vi.fn(async ({ data }: { data: object }) => saved = { id: "derivative", ...data }) } };
  const services = { db, read: vi.fn(async (key: string) => objects.get(key) ?? (key === "source" ? image : receipt)), put: vi.fn(async (key: string, bytes: Buffer) => { objects.set(key, bytes); }), quota: vi.fn(async () => null), view: vi.fn(async (value: unknown) => value), transaction: vi.fn(async (_db: unknown, _ids: string[], callback: (value: unknown) => unknown) => callback(db)) } as unknown as typeof furnitureAdjustmentServices;
  return { services, db, job, receipt, objects, rollback: () => { saved = undefined; } };
}
describe("saved furniture adjustment", () => {
  it("recovers after sidecar persistence and database rollback without changing immutable identity", async () => {
    const f = await fixture();
    const originalJob = JSON.stringify(f.job);
    vi.mocked(f.services.put).mockImplementation(async (key, bytes) => {
      const existing = f.objects.get(key);
      if (existing && !existing.equals(bytes)) throw new Error("Immutable image object changed.");
      f.objects.set(key, bytes);
    });
    vi.mocked(f.services.transaction).mockImplementation(async (_db, _ids, callback) => {
      try { return await callback(f.db as never); }
      catch (error) { f.rollback(); throw error; }
    });
    vi.mocked(f.services.view).mockRejectedValueOnce(new Error("Transient view failure"));
    const preview = await adjustFurnitureArea(actor, "job", region, undefined, f.services);
    await expect(adjustFurnitureArea(actor, "job", region, preview.hash, f.services)).rejects.toThrow("Transient view failure");
    expect(await f.db.mediaAsset.findFirst()).toBeUndefined();
    const sidecar = [...f.objects.entries()].find(([key]) => key.endsWith(".json"))!;
    await adjustFurnitureArea(actor, "job", region, preview.hash, f.services);
    await adjustFurnitureArea(actor, "job", region, preview.hash, f.services);
    const asset = await f.db.mediaAsset.findFirst() as { id: string; workspaceId: string; objectKey: string };
    expect(asset.id).toHaveLength(48);
    for (const role of ["first", "last"]) {
      expect(aiShotSchema.safeParse({ mode: "custom", first: { assetId: "original", atMs: 0 }, [role]: { assetId: asset.id, atMs: 0 } }).success).toBe(true);
    }
    expect(f.objects.get(sidecar[0])).toEqual(sidecar[1]);
    expect(f.db.mediaAsset.create).toHaveBeenCalledTimes(2);
    expect(await furnitureDerivativeKeyframe(asset, f.services)).toEqual({ id: "job", candidateKey: asset.objectKey, candidateHash: preview.hash });
    expect(JSON.stringify(f.job)).toBe(originalJob);
  });
  it("reloads trusted derivative identity and rejects changed key or metadata", async () => {
    const f = await fixture();
    const preview = await adjustFurnitureArea(actor, "job", region, undefined, f.services);
    await adjustFurnitureArea(actor, "job", region, preview.hash, f.services);
    const asset = await f.db.mediaAsset.findFirst() as { id: string; workspaceId: string; objectKey: string };
    expect(await furnitureDerivativeKeyframe(asset, f.services)).toEqual({ id: "job", candidateKey: asset.objectKey, candidateHash: preview.hash });
    await expect(furnitureDerivativeKeyframe({ ...asset, objectKey: asset.objectKey + "changed" }, f.services)).rejects.toThrow();
    vi.stubEnv("AI_VIDEO_ENABLED", "true"); vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test");
    const mediaSpy = vi.spyOn(prisma.mediaAsset, "findFirst").mockResolvedValue({ ...asset, kind: "IMAGE", contentType: "image/jpeg", sizeBytes: 100n, width: 1080, height: 1920 } as never);
    const jobSpy = vi.spyOn(prisma.aiKeyframe, "findFirst").mockResolvedValue(f.job as never);
    const readSpy = vi.spyOn(furnitureAdjustmentServices, "read").mockImplementation(f.services.read);
    const request = { requestId: "test", prompt: "A slow camera move", shot: { mode: "custom", last: { assetId: asset.id, atMs: 0 } } } as Parameters<typeof createAiGeneration>[1];
    try {
      await createAiGeneration({ ...actor, email: "test@example.test" }, request);
      expect(vi.mocked(reserveAiGeneration).mock.calls.at(-1)![1].frameSources).toEqual([{ key: asset.objectKey, kind: "IMAGE", atMs: 0, role: "last", keyframe: { jobId: "job", sha256: preview.hash } }]);
      await expect(createAiGeneration({ ...actor, email: "test@example.test" }, { ...request, shot: { ...request.shot!, compose: { last: "Change the room" } } })).rejects.toThrow("another image edit");
    } finally { mediaSpy.mockRestore(); jobSpy.mockRestore(); readSpy.mockRestore(); vi.unstubAllEnvs(); }
    const trusted = await furnitureDerivativeKeyframe(asset, f.services);
    const source = { key: trusted!.candidateKey, kind: "IMAGE", atMs: 0, role: "last", keyframe: { jobId: trusted!.id, sha256: trusted!.candidateHash } };
    const jpeg = f.objects.get(asset.objectKey)!;
    const s3 = { send: vi.fn(async () => ({ Body: Readable.from([jpeg]), ContentLength: jpeg.length })) } as unknown as S3Client;
    const frames = await aiFrames(s3, "test", [source]);
    expect(Buffer.from(frames[0].bytesBase64Encoded, "base64")).toEqual(preview.bytes);
    expect(execute).not.toHaveBeenCalled();
    await expect(aiFrames(s3, "test", [{ ...source, compose: "another image edit" }])).rejects.toThrow("Invalid approved");
    await expect(aiFrames(s3, "test", [{ ...source, keyframe: { ...source.keyframe, sha256: "0".repeat(64) } }])).rejects.toThrow("pixels changed");
    const metadata = JSON.parse(f.objects.get(`${asset.objectKey}.json`)!.toString());
    metadata.lineage.hash = "0".repeat(64);
    f.objects.set(`${asset.objectKey}.json`, Buffer.from(JSON.stringify(metadata)));
    await expect(furnitureDerivativeKeyframe(asset, f.services)).rejects.toThrow("identity changed");
  });
  it("accepts the existing 34 MiB receipt envelope", async () => {
    const f = await fixture();
    const receipt = JSON.parse(f.receipt.toString());
    receipt.padding = " ".repeat(32 * 1024 * 1024);
    expect(finalFurnitureImage(Buffer.from(JSON.stringify(receipt))).length).toBeGreaterThan(0);
  });

  it("retains the exact approved pixel rectangle", () => { expect(furnitureStagePixels({ version: 1, style: "warm-minimal", instructions: "", region }, 1080, 1920)).toEqual({ left: 0, top: 1017, width: 520, height: 223 }); });
  it("previews without writes and retains a separate derivative idempotently", async () => {
    const f = await fixture(); const before = JSON.stringify(f.job);
    const preview = await adjustFurnitureArea(actor, "job", region, undefined, f.services);
    expect(f.services.put).not.toHaveBeenCalled(); expect(f.services.transaction).not.toHaveBeenCalled();
    await adjustFurnitureArea(actor, "job", region, preview.hash, f.services);
    await adjustFurnitureArea(actor, "job", region, preview.hash, f.services);
    expect(f.services.put).toHaveBeenCalledTimes(3); expect(f.db.mediaAsset.create).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.job)).toBe(before);
  });
  it("rejects foreign workspaces, changed hashes, stale previews and a deleted owner inside save", async () => {
    const f = await fixture();
    await expect(adjustFurnitureArea({ ...actor, workspaceId: "foreign" }, "job", region, undefined, f.services)).rejects.toThrow();
    f.job.responseHash = "changed";
    await expect(adjustFurnitureArea(actor, "job", region, undefined, f.services)).rejects.toThrow("changed");
    f.job.responseHash = keyframeHash(f.receipt);
    await expect(adjustFurnitureArea(actor, "job", region, "stale", f.services)).rejects.toThrow("Preview changed");
    f.db.user.findFirst.mockResolvedValue(null as never);
    await expect(adjustFurnitureArea(actor, "job", region, "hash", f.services)).rejects.toThrow("Account unavailable");
    expect(f.services.put).not.toHaveBeenCalled();
  });
  it("rejects malformed, incomplete and oversized receipts", () => {
    for (const value of [Buffer.from("invalid"), Buffer.from(JSON.stringify({ version: 1, incomplete: true, status: 200, bodyBase64: "" })), Buffer.alloc(34 * 1024 * 1024 + 1)]) expect(() => finalFurnitureImage(value)).toThrow();
  });
});
