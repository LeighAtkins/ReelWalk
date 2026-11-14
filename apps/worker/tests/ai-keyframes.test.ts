import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { keyframeHash, makeKeyframeRequest, refundRefusedKeyframe, type AiKeyframe, type KeyframeSnapshot } from "@reelwalk/db";
import type { S3Client } from "@aws-sdk/client-s3";
vi.mock("../../web/lib/storage", () => ({ readKeyframeObject: vi.fn(), putKeyframeObject: vi.fn() }));
import { checkedKeyframeRequest, keyframeReceiptKey, keyframeWorkerServices, processKeyframes } from "../src/ai-keyframes";
const input = { role: "end" as const, source: { assetId: "photo", atMs: 0 as const }, move: "shift-right" as const, distanceM: 3, durationSeconds: 4 as const };
const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
const request = makeKeyframeRequest(input, png);
const snapshot: KeyframeSnapshot = { model: "gemini-3-pro-image", source: { assetId: "photo", objectKey: "photo.png", originalHash: keyframeHash(png), canonicalKey: "source.png", canonicalHash: keyframeHash(png) }, requestKey: "request.json", price: { inputPerMillion: 2, outputPerMillion: 120, inputTokenBound: 8192, outputTokenBound: 8192, maximumUsdMicros: 999424, evidence: "pricing" } };
const job = { id: "job", workspaceId: "w", userId: "u", grantId: "original-grant", requestId: "4ec2359d-c4af-490b-b5ec-36a88f499605", inputHash: keyframeHash(JSON.stringify(input)), requestHash: keyframeHash(request), input, snapshot, status: "QUEUED", heldCostCents: 100, credits: 1, creditRefunded: false, submittedAt: null } as unknown as AiKeyframe;
function fixture() {
  const row = { ...job };
  const objects = new Map<string, Buffer>([["photo.png", png], ["source.png", png], ["request.json", Buffer.from(request)]]);
  const update = vi.fn(async ({ where, data }) => {
    const status = where.status;
    if (where.id !== row.id || (typeof status === "string" ? row.status !== status : status?.in && !status.in.includes(row.status))) return { count: 0 };
    if (where.creditRefunded !== undefined && where.creditRefunded !== row.creditRefunded) return { count: 0 };
    for (const key of ["submittedAt", "responseKey", "responseHash"] as const) if (where[key]?.not === null && row[key] == null) return { count: 0 };
    Object.assign(row, data); return { count: 1 };
  });
  const creditUpdate = vi.fn();
  const tx = { $queryRaw: vi.fn(), aiCreditGrant: { update: creditUpdate }, workspace: { findUnique: vi.fn().mockResolvedValue({ aiGeneration: "on" }) }, user: { findFirst: vi.fn().mockResolvedValue({ id: "u" }) }, mediaAsset: { findFirst: vi.fn().mockResolvedValue({ id: "photo" }) }, aiKeyframe: { updateMany: update, findFirst: vi.fn().mockResolvedValue({ id: row.id }), findUniqueOrThrow: vi.fn(async () => ({ ...row })) } };
  const db = { aiKeyframe: { findMany: vi.fn(async () => ["UNKNOWN", "SUBMITTING"].includes(row.status) ? [{ ...row }] : []), findFirst: vi.fn(async () => row.status === "QUEUED" ? { ...row } : null), updateMany: update }, $transaction: vi.fn(async (fn: (db: typeof tx) => unknown) => fn(tx)) };
  const read = vi.fn(async (key: string) => { const value = objects.get(key); if (!value) throw new Error("Missing"); return value; });
  const put = vi.fn(async (key: string, bytes: Buffer) => { objects.set(key, bytes); });
  const submit = vi.fn();
  const services = { db, storageTransaction: (_db: unknown, _ids: string[], callback: (db: typeof tx) => unknown) => db.$transaction(callback), read, put, transport: vi.fn(async () => ({ submit })), enabled: () => true, failUnsubmitted: vi.fn(), refundRefused: vi.fn(refundRefusedKeyframe) } as unknown as typeof keyframeWorkerServices;
  return { row, objects, read, put, submit, services, tx, creditUpdate };
}
const s3 = { config: {} } as Pick<S3Client, "config">;
beforeEach(() => { vi.clearAllMocks(); });
describe("one-dispatch image worker", () => {
  it("does not recreate private files when the account is deleted while a paid response is in flight", async () => {
    const f = fixture();
    f.submit.mockImplementation(async () => {
      f.tx.aiKeyframe.findFirst.mockResolvedValue(null);
      return { version: 1, status: 200, incomplete: false, bodyBase64: "e30=" };
    });
    await processKeyframes(s3, f.services);
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw.mock.calls[0][0].join(" ")).toContain('FROM "Workspace"');
  });
  it("retains an unknown hold after timeout and never dispatches a second POST", async () => {
    const f = fixture(); f.submit.mockRejectedValue(new Error("timeout after request"));
    await processKeyframes(s3, f.services); await processKeyframes(s3, f.services);
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.row.status).toBe("UNKNOWN"); expect(f.row.heldCostCents).toBe(100);
    expect(f.services.failUnsubmitted).not.toHaveBeenCalled(); expect(f.row.assetId).toBeUndefined();
    expect(f.services.refundRefused).not.toHaveBeenCalled(); expect(f.row.creditRefunded).toBe(false);
  });
  it("allows only one concurrent worker to cross the dispatch claim", async () => {
    const f = fixture(); f.submit.mockRejectedValue(new Error("unknown"));
    await Promise.all([processKeyframes(s3, f.services), processKeyframes(s3, f.services)]);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("preserves raw output and makes a candidate without creating media or video", async () => {
    const f = fixture();
    const raw = await sharp({ create: { width: 16, height: 24, channels: 3, background: "#f0e0d0" } }).png().toBuffer();
    const bodyBase64 = Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: raw.toString("base64") } }] } }] })).toString("base64");
    f.submit.mockResolvedValue({ version: 1, status: 200, incomplete: false, bodyBase64 });
    await processKeyframes(s3, f.services);
    expect(f.row.status).toBe("CANDIDATE"); expect(f.row.heldCostCents).toBe(100); expect(f.row.assetId).toBeUndefined();
    expect(JSON.parse(f.objects.get(keyframeReceiptKey(job))!.toString()).bodyBase64).toBe(bodyBase64);
    expect(f.row.candidateKey).toBeTruthy();
    const jpeg = f.objects.get(f.row.candidateKey!)!;
    expect(keyframeHash(jpeg)).toBe(f.row.candidateHash); expect(await sharp(jpeg).metadata()).toMatchObject({ width: 1080, height: 1920, format: "jpeg" });
    expect(f.submit).toHaveBeenCalledWith(request);
  });
  it.each([
    { label: "thought image plus one final", thoughts: 1, finals: 1, expected: "CANDIDATE" },
    { label: "thought image only", thoughts: 1, finals: 0, expected: "FAILED" },
    { label: "two final images", thoughts: 0, finals: 2, expected: "FAILED" },
  ])("accepts exactly one final image for $label and retains all raw parts", async ({ thoughts, finals, expected }) => {
    const f = fixture();
    const raw = await sharp({ create: { width: 12, height: 18, channels: 3, background: "white" } }).png().toBuffer();
    const inlineData = { mimeType: "image/png", data: raw.toString("base64") };
    const parts = [...Array.from({ length: thoughts }, () => ({ thought: true, inlineData })), ...Array.from({ length: finals }, () => ({ inlineData }))];
    const bodyBase64 = Buffer.from(JSON.stringify({ candidates: [{ content: { parts } }] })).toString("base64");
    f.submit.mockResolvedValue({ version: 1, status: 200, incomplete: false, bodyBase64 });
    await processKeyframes(s3, f.services);
    expect(f.row.status).toBe(expected); expect(f.row.heldCostCents).toBe(100); expect(f.row.assetId).toBeUndefined();
    expect(JSON.parse(f.objects.get(keyframeReceiptKey(job))!.toString()).bodyBase64).toBe(bodyBase64);
    expect(f.row.candidateKey !== undefined).toBe(expected === "CANDIDATE");
    expect(f.row.creditRefunded).toBe(false); expect(f.services.refundRefused).not.toHaveBeenCalled();
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("recovers a stored receipt after a lost DB response without a model call", async () => {
    const f = fixture(); f.row.status = "UNKNOWN"; f.row.submittedAt = new Date("2026-01-01");
    f.objects.set(keyframeReceiptKey(job), Buffer.from(JSON.stringify({ version: 1, status: 429, incomplete: false, bodyBase64: Buffer.from("rejected").toString("base64") })));
    await processKeyframes(s3, f.services);
    expect(f.row.status).toBe("FAILED"); expect(f.row.responseKey).toBe(keyframeReceiptKey(job)); expect(f.row.heldCostCents).toBe(100); expect(f.submit).not.toHaveBeenCalled();
    expect(f.row.creditRefunded).toBe(true); expect(f.creditUpdate).toHaveBeenCalledTimes(1);
  });
  it("returns a retained HTTP400's credit exactly once while keeping the full cash hold", async () => {
    const f = fixture(); f.submit.mockResolvedValue({ version: 1, status: 400, incomplete: false, bodyBase64: Buffer.from("provider refusal").toString("base64") });
    await processKeyframes(s3, f.services);
    expect(f.row.status).toBe("FAILED"); expect(f.row.creditRefunded).toBe(true); expect(f.row.heldCostCents).toBe(100);
    expect(f.row.error).toContain("Your 1 AI credit was returned");
    expect(f.creditUpdate).toHaveBeenCalledWith({ where: { id: "original-grant" }, data: { remaining: { increment: 1 } } });
    expect(f.objects.has(keyframeReceiptKey(job))).toBe(true);
    await Promise.all([processKeyframes(s3, f.services), processKeyframes(s3, f.services), refundRefusedKeyframe(f.services.db, "job", 400)]);
    expect(f.creditUpdate).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledTimes(1); expect(f.row.heldCostCents).toBe(100);
  });
  it("recovers a paid image after temporary candidate storage failure, with no new POST", async () => {
    const f = fixture();
    const raw = await sharp({ create: { width: 12, height: 18, channels: 3, background: "white" } }).png().toBuffer();
    f.submit.mockResolvedValue({ version: 1, status: 200, incomplete: false, bodyBase64: Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: raw.toString("base64") } }] } }] })).toString("base64") });
    let failCandidate = true;
    f.put.mockImplementation(async (key, bytes) => { if (key.includes("/candidates/") && failCandidate) { failCandidate = false; throw new Error("storage unavailable"); } f.objects.set(key, bytes); });
    await processKeyframes(s3, f.services); expect(f.row.status).toBe("UNKNOWN"); expect(f.objects.has(keyframeReceiptKey(job))).toBe(true);
    // A restarted worker only needs the retained receipt; it must not keep the idle task alive.
    expect(await processKeyframes(s3, f.services)).toBe(false); expect(f.row.status).toBe("CANDIDATE"); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("does not keep workers alive for a permanently unknown response or retry the model", async () => {
    const f = fixture(); f.row.status = "UNKNOWN"; f.row.submittedAt = new Date("2026-01-01");
    expect(await processKeyframes(s3, f.services)).toBe(false);
    expect(f.row.status).toBe("UNKNOWN"); expect(f.row.heldCostCents).toBe(100);
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("retains incomplete provider bytes and unknown cost", async () => {
    const f = fixture(); f.submit.mockResolvedValue({ version: 1, status: 400, incomplete: true, bodyBase64: "YWJj" });
    await processKeyframes(s3, f.services);
    expect(f.row.status).toBe("UNKNOWN"); expect(f.row.heldCostCents).toBe(100); expect(f.objects.get(keyframeReceiptKey(job))!.toString()).toContain("YWJj");
    expect(f.services.refundRefused).not.toHaveBeenCalled(); expect(f.row.creditRefunded).toBe(false);
  });
  it("stops before auth or POST when frozen source hash or exact model changes", async () => {
    const f = fixture(); f.objects.set("source.png", Buffer.from("wrong pixels"));
    await processKeyframes(s3, f.services);
    expect(f.services.transport).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.services.failUnsubmitted).toHaveBeenCalled();
    await expect(checkedKeyframeRequest({ ...job, snapshot: { ...snapshot, model: "fallback-model" } } as unknown as AiKeyframe, f.read)).rejects.toThrow("exact image model");
  });
  it("does not submit after original pixels or workspace access change", async () => {
    const f = fixture(); f.objects.set("photo.png", Buffer.from("replacement original"));
    await processKeyframes(s3, f.services); expect(f.submit).not.toHaveBeenCalled(); expect(f.services.failUnsubmitted).toHaveBeenCalled();
    const revoked = fixture(); revoked.tx.user.findFirst.mockResolvedValue(null);
    await processKeyframes(s3, revoked.services); expect(revoked.submit).not.toHaveBeenCalled(); expect(revoked.services.failUnsubmitted).toHaveBeenCalled();
  });
});
