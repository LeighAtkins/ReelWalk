import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiShotFromClips, clipSchema, emptyTimeline } from "@reelwalk/core";
import type { S3Client } from "@aws-sdk/client-s3";
const { claim, fail, frames, thumbnail, submit, poll, compose, tts, startSync, pollSync, fetchTake, tx, db } = vi.hoisted(() => {
  const tx = { aiGeneration: { updateMany: vi.fn() }, mediaAsset: { upsert: vi.fn() }, reel: { findFirst: vi.fn(), upsert: vi.fn() } };
  return { claim: vi.fn(), fail: vi.fn(), frames: vi.fn(), thumbnail: vi.fn(), submit: vi.fn(), poll: vi.fn(), compose: vi.fn(), tts: vi.fn(), startSync: vi.fn(), pollSync: vi.fn(), fetchTake: vi.fn(), tx,
    db: { aiGeneration: { findFirst: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn() } };
});
vi.mock("@reelwalk/db", () => ({ claimAiGeneration: claim, failAiGeneration: fail, prisma: db }));
vi.mock("../src/ai-thumbnail", () => ({ aiThumbnail: thumbnail }));
vi.mock("../src/ai-frames", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai-frames")>()), aiFrames: frames }));
vi.mock("../src/vertex-images", () => ({ VertexImages: class { compose = compose; } }));
vi.mock("../src/voice", () => ({ lipsyncConfigured: () => true, voicedPrompt: (p: string, l: string) => `${p} [${l}]`, synthesiseLine: tts, startLipsync: startSync, pollLipsync: pollSync, fetchVideo: fetchTake }));
vi.mock("../src/transcribe", () => ({ transcriptionAvailable: () => false, transcribeVideo: async () => null }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async (_s3: unknown, command: { input: { Key: string } }) => `https://signed/${command.input.Key}` }));
vi.mock("../src/vertex-video", () => ({
  VertexError: class extends Error {}, VertexVideo: class { submit = submit; poll = poll; },
}));
import { processAiVideo } from "../src/ai-video";

const a = clipSchema.parse({ id: "a", assetId: "real-a", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 5000 });
const b = clipSchema.parse({ id: "b", assetId: "real-b", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 });
const source = { id: "reel", title: "My listing", timeline: { ...emptyTimeline(), clips: [a, b] }, caption: "My caption" };
const job = { id: "one", workspaceId: "studio", status: "SUBMITTING", leaseToken: "mine", model: "veo", durationSeconds: 8, prompt: "Move", frameSources: ["frames"],
  shot: { ...aiShotFromClips("burst", a, b), draftReelId: "reel" }, createdAt: new Date(), operationName: "saved-operation" };
const s3 = { config: {}, send: vi.fn() } as unknown as S3Client;

beforeEach(() => {
  vi.clearAllMocks();
  db.aiGeneration.findFirst.mockResolvedValue(null);
  tx.aiGeneration.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async fn => fn(tx));
  frames.mockResolvedValue([{ bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" }]);
  thumbnail.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
  submit.mockResolvedValue("operation-one");
  poll.mockResolvedValue({ done: true, video: Buffer.alloc(1000) });
  tx.reel.findFirst.mockResolvedValue(source);
});

describe("AI shot worker", () => {
  it("submits both decoded boundary frames and saves the operation for polling", async () => {
    claim.mockResolvedValue(job);
    await processAiVideo(s3, "media");
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move", { bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" }, false);
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "one", leaseToken: "mine", status: "SUBMITTING" }, data: expect.objectContaining({ operationName: "operation-one" }) }));
  });
  const composed = [{ bytesBase64Encoded: "first", mimeType: "image/jpeg", role: "first", compose: "At the door, head below the lintel." }, { bytesBase64Encoded: "last", mimeType: "image/jpeg", role: "last" }, { bytesBase64Encoded: "her", mimeType: "image/jpeg", role: "presenter" }];
  it("composes a described start still with the presenter before submitting, and keeps a copy", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed);
    compose.mockResolvedValueOnce({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledWith("first", "At the door, head below the lintel.", { bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "her", mimeType: "image/jpeg" });
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move", { bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" }, false);
    expect((s3.send as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command.input?.Key)).toContain("workspaces/studio/ai/one-first.jpg");
  });
  it("refunds when a still cannot be composed, before anything is paid", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed); compose.mockRejectedValueOnce(new Error("no image"));
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("composed"), true);
  });
  const spoken = { ...job, shot: { mode: "custom", line: "Who needs a front door?", voice: "lipsync" } };
  it("submits a lipsync take silent with the line in the prompt, then hands the finished take to sync.so", async () => {
    claim.mockResolvedValue(spoken);
    await processAiVideo(s3, "media");
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move [Who needs a front door?]", expect.anything(), expect.anything(), false);
    claim.mockResolvedValue({ ...spoken, status: "RUNNING" }); tts.mockResolvedValue(Buffer.from("mp3")); startSync.mockResolvedValue("sync-1");
    await processAiVideo(s3, "media");
    expect(startSync).toHaveBeenCalledWith("https://signed/workspaces/studio/ai/one-silent.mp4", "https://signed/workspaces/studio/ai/one-line.mp3", "reelwalk-one");
    expect(db.aiGeneration.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ operationName: "lipsync:sync-1" }) }));
    expect(tx.mediaAsset.upsert).not.toHaveBeenCalled();
  });
  it("stores the lip-synced take when sync.so finishes, and asks Veo for audio in veo mode", async () => {
    claim.mockResolvedValue({ ...spoken, status: "RUNNING", operationName: "lipsync:sync-1" });
    pollSync.mockResolvedValue({ done: true, url: "https://out/take.mp4" }); fetchTake.mockResolvedValue(Buffer.alloc(2000));
    await processAiVideo(s3, "media");
    expect(poll).not.toHaveBeenCalled();
    expect(tx.mediaAsset.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ fileName: expect.stringContaining("Who needs a front door?") }) }));
    vi.clearAllMocks(); db.$transaction.mockImplementation(async fn => fn(tx)); tx.aiGeneration.updateMany.mockResolvedValue({ count: 1 });
    claim.mockResolvedValue({ ...spoken, shot: { ...spoken.shot, voice: "veo" } }); frames.mockResolvedValue([]); submit.mockResolvedValue("op");
    await processAiVideo(s3, "media");
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move [Who needs a front door?]", undefined, undefined, true);
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
  it("carries the selected cinematic direction through a background draft without changing its source", async () => {
    claim.mockResolvedValue({ ...job, status: "RUNNING", shot: { ...job.shot, mode: "orbit", style: "neon", atmosphere: "blue-hour", energy: "bold", harmonize: true } });
    await processAiVideo(s3, "media");
    const timeline = tx.reel.upsert.mock.calls[0][0].create.timeline;
    expect(timeline.clips.map((clip: { filter: string }) => clip.filter)).toEqual(["cool", "cool", "cool"]);
    expect(source.timeline.clips.map(clip => clip.filter)).toEqual(["none", "none"]);
    expect(submit).not.toHaveBeenCalled();
  });
  it("saves a real frame thumbnail before exposing the completed AI clip", async () => {
    claim.mockResolvedValue({ ...job, status: "RUNNING" });
    await processAiVideo(s3, "media");
    expect(thumbnail).toHaveBeenCalledWith(expect.any(Buffer));
    expect(tx.mediaAsset.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { thumbKey: "workspaces/studio/ai/one.jpg" },
      create: expect.objectContaining({ thumbKey: "workspaces/studio/ai/one.jpg" }),
    }));
    expect((s3.send as ReturnType<typeof vi.fn>).mock.calls.some(([command]) => command.input.ContentType === "image/jpeg")).toBe(true);
  });
  it("retries thumbnail import through the saved operation without another generation or refund", async () => {
    claim.mockResolvedValue({ ...job, status: "RUNNING" });
    thumbnail.mockRejectedValueOnce(new Error("temporary decode failure"));
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(tx.mediaAsset.upsert).not.toHaveBeenCalled();
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "one", leaseToken: "mine" }, data: expect.objectContaining({ nextPollAt: expect.any(Date) }),
    }));
  });
  it("a lost lease cannot create an output or draft", async () => {
    claim.mockResolvedValue({ ...job, status: "RUNNING" });
    tx.aiGeneration.updateMany.mockResolvedValueOnce({ count: 0 });
    await processAiVideo(s3, "media");
    expect(tx.reel.upsert).not.toHaveBeenCalled();
    expect(tx.mediaAsset.upsert).not.toHaveBeenCalled();
  });
});
