import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { keyframeHash, KeyframeError, type AiKeyframe } from "@reelwalk/db";
import { continueKeyframePair, keyframePairServices, normalizeKeyframeSource } from "./ai-keyframes";
const actor = { id: "u", workspaceId: "w" };
const startId = "4ec2359d-c4af-490b-b5ec-36a88f499605", endId = "8238259d-c4af-490b-b5ec-36a88f499605";
beforeEach(() => { vi.stubEnv("AI_KEYFRAMES_ENABLED", "true"); vi.stubEnv("GOOGLE_CLOUD_PROJECT", "fixture"); });
function fixture() {
  const original = Buffer.from("frozen original"), candidate = Buffer.from("frozen candidate");
  const input = { role: "start", source: { assetId: "original", atMs: 0 }, move: "shift-right", distanceM: 3, durationSeconds: 4, cinematography: { version: 1, lensMm: "source", whiteBalanceKelvin: "source" }, guidedPair: { version: 1, id: startId, endRequestId: endId } };
  const row = { id: "start-job", requestId: startId, workspaceId: "w", userId: "u", status: "CANDIDATE", input, candidateKey: "candidate.jpg", candidateHash: keyframeHash(candidate), heldCostCents: 100, snapshot: { source: { assetId: "original", objectKey: "original.jpg", originalHash: keyframeHash(original) } } } as unknown as AiKeyframe;
  const db = { user: { findFirst: vi.fn().mockResolvedValue({ id: "u" }) }, workspace: { findUnique: vi.fn().mockResolvedValue({ aiGeneration: "on" }) },
    mediaAsset: { findFirst: vi.fn().mockResolvedValue({ id: "original" }) }, aiKeyframe: { findFirst: vi.fn(async ({ where }) => where.workspaceId === row.workspaceId ? row : null), updateMany: vi.fn(async ({ data }) => { Object.assign(row, data); return { count: 1 }; }) } };
  const read = vi.fn(async (key: string) => key === "original.jpg" ? original : candidate);
  const retain = vi.fn(async () => { row.status = "USED"; row.assetId = "retained-start"; return { job: row, asset: { id: "retained-start" } }; });
  const ends = new Map<string, object>();
  const generate = vi.fn(async (_actor, value, options?: unknown) => { void options; if (!ends.has(value.requestId)) ends.set(value.requestId, { id: "one-end", requestId: value.requestId, status: "QUEUED", input: value }); return ends.get(value.requestId); });
  const services = { db, read, retain, generate, view: async (value: AiKeyframe) => value } as unknown as typeof keyframePairServices;
  return { row, db, read, retain, generate, ends, services };
}
it("concurrent continuations retain the original reference and submit the same bounded End identity", async () => {
  const f = fixture();
  await Promise.all([continueKeyframePair(actor, "start-job", f.services), continueKeyframePair(actor, "start-job", f.services)]);
  expect(f.ends.size).toBe(1);
  for (const [, value, options] of f.generate.mock.calls) {
    expect(value).toMatchObject({ requestId: endId, role: "end", source: { assetId: "original", atMs: 0 }, continuity: { assetId: "retained-start", atMs: 0 } });
    expect(value).not.toHaveProperty("guidedPair");
    expect(options).toEqual({ expectedSource: (f.row.snapshot as { source: unknown }).source, expectedContinuity: { objectKey: f.row.candidateKey, originalHash: f.row.candidateHash } });
  }
  expect(f.row.status).toBe("USED"); expect(f.row.heldCostCents).toBe(100);
});
it("retains paid Start after End admission fails, and explicit continuation reuses the End ID", async () => {
  const f = fixture(); f.generate.mockRejectedValueOnce(new KeyframeError("No credits left"));
  const paused = await continueKeyframePair(actor, "start-job", f.services);
  expect(paused.continuationError).toContain("No credits left"); expect(f.row.status).toBe("USED"); expect(f.row.heldCostCents).toBe(100);
  const resumed = await continueKeyframePair(actor, "start-job", f.services);
  expect(resumed.continuationError).toBeNull(); expect(f.generate.mock.calls.map(call => call[1].requestId)).toEqual([endId, endId]);
});
it("reconciles a committed End after its response is lost using the same End request", async () => {
  const f = fixture();
  f.generate.mockImplementationOnce(async (_actor, value) => { f.ends.set(value.requestId, { id: "committed-end", requestId: value.requestId, status: "UNKNOWN" }); throw new Error("Connection lost after admission"); });
  const interrupted = await continueKeyframePair(actor, "start-job", f.services);
  expect(interrupted.endJob).toBeNull(); expect(f.row.status).toBe("USED");
  const recovered = await continueKeyframePair(actor, "start-job", f.services);
  expect(recovered.endJob).toMatchObject({ id: "committed-end", status: "UNKNOWN" });
  expect(f.ends.size).toBe(1); expect(f.generate.mock.calls.map(call => call[1].requestId)).toEqual([endId, endId]);
});
it.each(["UNKNOWN", "FAILED", "SUBMITTING"])("never advances a %s Start", async status => {
  const f = fixture(); f.row.status = status;
  await expect(continueKeyframePair(actor, "start-job", f.services)).rejects.toThrow("Wait for the saved Start");
  expect(f.retain).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
});
it("rejects revoked membership or deletion before retaining media or admitting End", async () => {
  const f = fixture(); f.db.user.findFirst.mockResolvedValue(null);
  await expect(continueKeyframePair(actor, "start-job", f.services)).rejects.toThrow("no longer has access");
  expect(f.read).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  const deleted = fixture(); deleted.db.aiKeyframe.findFirst.mockResolvedValue(null);
  await expect(continueKeyframePair(actor, "start-job", deleted.services)).rejects.toThrow("unavailable");
  expect(deleted.retain).not.toHaveBeenCalled(); expect(deleted.generate).not.toHaveBeenCalled();
});
it("rejects changed or inaccessible original pixels and leaves successful Start status intact", async () => {
  for (const unavailable of [false, true]) {
    const f = fixture(); if (unavailable) f.db.mediaAsset.findFirst.mockResolvedValue(null); else f.read.mockResolvedValue(Buffer.from("changed"));
    const result = await continueKeyframePair(actor, "start-job", f.services);
    expect(result.continuationError).toContain("reference changed"); expect(f.row.status).toBe("CANDIDATE");
    expect(f.retain).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  }
});
it("rejects changed retained Start pixels before End admission", async () => {
  const f = fixture(); f.row.candidateHash = "changed";
  const result = await continueKeyframePair(actor, "start-job", f.services);
  expect(result.continuationError).toContain("saved Start pixels changed"); expect(f.row.status).toBe("CANDIDATE");
  expect(f.retain).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
});
it("retains full landscape edges within pixel bounds without enlarging a new reference", async () => {
  const source = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "white" } }).composite([
    { input: await sharp({ create: { width: 400, height: 600, channels: 3, background: "red" } }).png().toBuffer(), left: 0, top: 0 },
    { input: await sharp({ create: { width: 400, height: 600, channels: 3, background: "blue" } }).png().toBuffer(), left: 800, top: 0 },
  ]).png().toBuffer();
  const result = await normalizeKeyframeSource(source, true), metadata = await sharp(result.png).metadata();
  expect(metadata).toMatchObject({ width: 1200, height: 600 });
  expect(result.normalization).toEqual({ version: 2, fit: "inside", width: 1200, height: 600 });
  expect([...await sharp(result.png).removeAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()]).toEqual([255, 0, 0]);
  expect([...await sharp(result.png).removeAlpha().extract({ left: 1199, top: 0, width: 1, height: 1 }).raw().toBuffer()]).toEqual([0, 0, 255]);
  expect(await sharp((await normalizeKeyframeSource(source)).png).metadata()).toMatchObject({ width: 1080, height: 1920 });
});
it("accounts for EXIF rotation and caps large square references at the old pixel budget", async () => {
  const rotated = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "white" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  expect(await sharp((await normalizeKeyframeSource(rotated, true)).png).metadata()).toMatchObject({ width: 960, height: 1920 });
  const square = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
  const meta = await sharp((await normalizeKeyframeSource(square, true)).png).metadata();
  expect(meta.width! * meta.height!).toBeLessThanOrEqual(1080 * 1920); expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1920);
});
