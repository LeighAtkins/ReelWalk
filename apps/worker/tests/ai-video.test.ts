import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiShotFromClips, clipSchema, emptyTimeline } from "@reelwalk/core";
import type { S3Client } from "@aws-sdk/client-s3";
const { claim, fail, frames, submit, poll, tx, db } = vi.hoisted(() => {
  const tx = { aiGeneration: { updateMany: vi.fn() }, mediaAsset: { upsert: vi.fn() }, reel: { findFirst: vi.fn(), upsert: vi.fn() } };
  return { claim: vi.fn(), fail: vi.fn(), frames: vi.fn(), submit: vi.fn(), poll: vi.fn(), tx,
    db: { aiGeneration: { findFirst: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn() } };
});
vi.mock("@reelwalk/db", () => ({ claimAiGeneration: claim, failAiGeneration: fail, prisma: db }));
vi.mock("../src/ai-frames", () => ({ aiFrames: frames }));
vi.mock("../src/vertex-video", () => ({
  VertexError: class extends Error {}, VertexVideo: class { submit = submit; poll = poll; },
}));
import { processAiVideo } from "../src/ai-video";

const a = clipSchema.parse({ id: "a", assetId: "real-a", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 5000 });
const b = clipSchema.parse({ id: "b", assetId: "real-b", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 });
const source = { id: "reel", title: "My listing", timeline: { ...emptyTimeline(), clips: [a, b] }, caption: "My caption" };
const job = { id: "one", workspaceId: "studio", status: "SUBMITTING", leaseToken: "mine", model: "veo", prompt: "Move", frameSources: ["frames"],
  shot: { ...aiShotFromClips("burst", a, b), draftReelId: "reel" }, createdAt: new Date(), operationName: "saved-operation" };
const s3 = { config: {}, send: vi.fn() } as unknown as S3Client;

beforeEach(() => {
  vi.clearAllMocks();
  db.aiGeneration.findFirst.mockResolvedValue(null);
  tx.aiGeneration.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async fn => fn(tx));
  frames.mockResolvedValue([{ bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" }]);
  submit.mockResolvedValue("operation-one");
  poll.mockResolvedValue({ done: true, video: Buffer.alloc(1000) });
  tx.reel.findFirst.mockResolvedValue(source);
});

describe("AI shot worker", () => {
  it("submits both decoded boundary frames and saves the operation for polling", async () => {
    claim.mockResolvedValue(job);
    await processAiVideo(s3, "media");
    expect(submit).toHaveBeenCalledWith("veo", "Move", { bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" });
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "one", leaseToken: "mine", status: "SUBMITTING" }, data: expect.objectContaining({ operationName: "operation-one" }) }));
  });
  it("refunds failed extraction and releases budget without calling the paid API", async () => {
    claim.mockResolvedValue(job); frames.mockRejectedValueOnce(new Error("decode"));
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("frames"), true);
  });
  it("atomically saves a private promo draft without writing to the original reel", async () => {
    claim.mockResolvedValue({ ...job, status: "RUNNING" });
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledWith("veo", "saved-operation");
    const draft = tx.reel.upsert.mock.calls[0][0];
    expect(draft.where.id).toBe("ai-promo-one");
    expect(draft.create).toMatchObject({ workspaceId: "studio", caption: "My caption" });
    expect(draft.create.timeline.clips.map((c: { assetId: string }) => c.assetId)).toEqual(["real-a", "ai-one", "real-b"]);
    expect(draft.create.timeline.clips[1]).toMatchObject({ speed: 4, sourceEndMs: 8000 });
    expect(draft.create.shareToken).toBeUndefined();
    expect(source.timeline.clips).toHaveLength(2);
  });
  it("keeps the successful library clip when the source boundary changed", async () => {
    claim.mockResolvedValue({ ...job, status: "RUNNING" });
    tx.reel.findFirst.mockResolvedValueOnce({ ...source, timeline: { ...source.timeline, clips: [b, a] } });
    await processAiVideo(s3, "media");
    expect(tx.mediaAsset.upsert).toHaveBeenCalledOnce();
    expect(tx.reel.upsert).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
  it("a lost lease cannot create an output or draft", async () => {
    claim.mockResolvedValue({ ...job, status: "RUNNING" });
    tx.aiGeneration.updateMany.mockResolvedValueOnce({ count: 0 });
    await processAiVideo(s3, "media");
    expect(tx.reel.upsert).not.toHaveBeenCalled();
    expect(tx.mediaAsset.upsert).not.toHaveBeenCalled();
  });
});
