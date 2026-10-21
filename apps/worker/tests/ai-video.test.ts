import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiShotFromClips, clipSchema, emptyTimeline } from "@reelwalk/core";
import type { S3Client } from "@aws-sdk/client-s3";
const { claim, fail, frames, thumbnail, submit, poll, compose, identity, tts, startSync, pollSync, fetchTake, tx, db } = vi.hoisted(() => {
  const tx = { aiGeneration: { updateMany: vi.fn() }, mediaAsset: { upsert: vi.fn() }, reel: { findFirst: vi.fn(), upsert: vi.fn() } };
  return { claim: vi.fn(), fail: vi.fn(), frames: vi.fn(), thumbnail: vi.fn(), submit: vi.fn(), poll: vi.fn(), compose: vi.fn(), identity: vi.fn(), tts: vi.fn(), startSync: vi.fn(), pollSync: vi.fn(), fetchTake: vi.fn(), tx,
    db: { aiGeneration: { findFirst: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn() } };
});
vi.mock("@reelwalk/db", () => ({ claimAiGeneration: claim, failAiGeneration: fail, prisma: db }));
vi.mock("../src/ai-thumbnail", () => ({ aiThumbnail: thumbnail }));
vi.mock("../src/ai-frames", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai-frames")>()), aiFrames: frames }));
vi.mock("../src/vertex-images", () => ({ VertexImages: class { compose = compose; checkIdentity = identity; } }));
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
  db.aiGeneration.updateMany.mockResolvedValue({ count: 1 });
  tx.aiGeneration.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async fn => fn(tx));
  frames.mockResolvedValue([{ bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" }]);
  thumbnail.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
  submit.mockResolvedValue("operation-one");
  poll.mockResolvedValue({ done: true, video: Buffer.alloc(1000) });
  tx.reel.findFirst.mockResolvedValue(source);
  identity.mockResolvedValue({ samePerson: true, confidence: 0.9, faceHeightPx: 240 });
});

describe("AI shot worker", () => {
  it("submits both decoded boundary frames and saves the operation for polling", async () => {
    claim.mockResolvedValue(job);
    await processAiVideo(s3, "media");
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move", { bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" }, false);
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "one", leaseToken: "mine", status: { in: ["SUBMITTING", "UNRESOLVED"] } }, data: expect.objectContaining({ operationName: "operation-one" }) }));
  });
  // Review P1: a refunded generation must never reach Veo, and a submitted one must never be refunded by recovery.
  it("fences the paid call: records submitStartedAt under the lease, then submits", async () => {
    claim.mockResolvedValue(job);
    await processAiVideo(s3, "media");
    const calls = db.aiGeneration.updateMany.mock.calls, at = calls.findIndex(([args]) => args.data.submitStartedAt);
    expect(calls[at][0].where).toEqual({ id: "one", leaseToken: "mine", status: "SUBMITTING", submitStartedAt: null });
    expect(db.aiGeneration.updateMany.mock.invocationCallOrder[at]).toBeLessThan(submit.mock.invocationCallOrder[0]);
  });
  it("refund then submit: once recovery has refunded the row, the original worker does not submit", async () => {
    claim.mockResolvedValue(job);
    db.aiGeneration.updateMany.mockResolvedValue({ count: 0 }); // the fence finds the row FAILED
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
  it("refund during preparation: a lost lease stops the compose and check loop before more spend", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: false, confidence: 0.2, faceHeightPx: 200 });
    db.aiGeneration.updateMany.mockResolvedValue({ count: 0 }); // the renewal finds the row refunded
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    compose.mockReset();
  });
  it("submit then recovery: a stale row past the fence is UNRESOLVED, never refunded", async () => {
    db.aiGeneration.findFirst.mockResolvedValueOnce({ id: "sent", status: "SUBMITTING", submitStartedAt: new Date() });
    await processAiVideo(s3, "media");
    expect(fail).not.toHaveBeenCalled();
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: "sent", status: "SUBMITTING", submitStartedAt: { not: null } }), data: expect.objectContaining({ status: "UNRESOLVED" }) });
    expect(claim).not.toHaveBeenCalled();
  });
  it("recovery refunds a stale row still being prepared, only if it is still unsent and lapsed", async () => {
    db.aiGeneration.findFirst.mockResolvedValueOnce({ id: "prep", status: "SUBMITTING", submitStartedAt: null });
    await processAiVideo(s3, "media");
    expect(fail).toHaveBeenCalledWith(db, "prep", expect.stringContaining("interrupted"), false, { onlyIf: { status: "SUBMITTING", submitStartedAt: null, leaseUntil: { lt: expect.any(Date) } } });
  });
  const composed = [{ bytesBase64Encoded: "first", mimeType: "image/jpeg", role: "first", compose: "At the door, head below the lintel." }, { bytesBase64Encoded: "last", mimeType: "image/jpeg", role: "last" }, { bytesBase64Encoded: "her", mimeType: "image/jpeg", role: "presenter" }];
  it("composes a described start still with the presenter before submitting, and keeps a copy", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed);
    compose.mockResolvedValueOnce({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledWith("first", "At the door, head below the lintel.", { bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "her", mimeType: "image/jpeg" }, undefined, { framing: "medium", stronger: false });
    // Without a kit the gate compares against the presenter frame itself.
    expect(identity).toHaveBeenCalledWith({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, { bytesBase64Encoded: "her", mimeType: "image/jpeg" });
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move", { bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" }, false);
    expect((s3.send as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command.input?.Key)).toContain("workspaces/studio/ai/one-first.jpg");
  });
  it("refunds when a still cannot be composed, before anything is paid", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed); compose.mockRejectedValueOnce(new Error("no image"));
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("composed"), true, expect.anything());
  });
  // ADR 0056: the kit's full-length still and face crop, and the identity gate before Veo is paid.
  const kit = [{ bytesBase64Encoded: "scene", mimeType: "image/png", role: "first", compose: "Beside the island bench, waist above it.", framing: "medium" }, { bytesBase64Encoded: "body", mimeType: "image/png", role: "presenter" }, { bytesBase64Encoded: "face", mimeType: "image/png", role: "face" }];
  const keys = () => (s3.send as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command.input?.Key);
  it("composes from the kit's full-length still and face crop, gates on her face, and records the score", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValueOnce({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: true, confidence: 0.82, faceHeightPx: 210 });
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledWith("first", "Beside the island bench, waist above it.", { bytesBase64Encoded: "scene", mimeType: "image/png" }, { bytesBase64Encoded: "body", mimeType: "image/png" }, { bytesBase64Encoded: "face", mimeType: "image/png" }, { framing: "medium", stronger: false });
    expect(identity).toHaveBeenCalledWith({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, { bytesBase64Encoded: "face", mimeType: "image/png" });
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move", { bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, undefined, false);
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "RUNNING", identityScore: 0.82,
      identityChecks: [{ end: "first", attempt: 1, samePerson: true, confidence: 0.82, faceHeightPx: 210 }] }) }));
  });
  it("recomposes once with a stronger instruction when the face misses, then pays only for the match", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValueOnce({ bytesBase64Encoded: "drifted", mimeType: "image/jpeg" }).mockResolvedValueOnce({ bytesBase64Encoded: "her-again", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: false, confidence: 0.3, faceHeightPx: 64 }).mockResolvedValueOnce({ samePerson: true, confidence: 0.7, faceHeightPx: 230 });
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenLastCalledWith("first", expect.any(String), expect.anything(), expect.anything(), expect.anything(), { framing: "medium", stronger: true });
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move", { bytesBase64Encoded: "her-again", mimeType: "image/jpeg" }, undefined, false);
    expect(keys()).toEqual(expect.arrayContaining(["workspaces/studio/ai/one-first.jpg", "workspaces/studio/ai/one-first-retry.jpg"]));
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ identityScore: 0.7 }) }));
  });
  it("refunds and records identity_rejected with both scores when the face misses twice; Veo is never called", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValue({ bytesBase64Encoded: "someone-else", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: true, confidence: 0.4, faceHeightPx: 70 }).mockResolvedValueOnce({ samePerson: false, confidence: 0.55, faceHeightPx: 80 });
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("scores 0.40, 0.55"), true, expect.objectContaining({ failureCode: "identity_rejected", identityScore: 0.4,
      identityChecks: [expect.objectContaining({ attempt: 1, confidence: 0.4 }), expect.objectContaining({ attempt: 2, confidence: 0.55 })] }));
    compose.mockReset();
  });
  it("treats an identity check that cannot run as a miss, never as a pass", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockRejectedValue(new Error("HTTP 503"));
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("unchecked, unchecked"), true, expect.objectContaining({ failureCode: "identity_rejected" }));
    identity.mockReset(); compose.mockReset();
  });
  it("reads back a pre-ADR-0056 row that named a generated take, keeping its voice", async () => {
    const legacy = { ...job, shot: { mode: "custom", first: { assetId: "real-a", atMs: 0 }, line: "Welcome home.", voice: "veo", compose: { presenter: { assetId: "ai-old", atMs: 0 }, first: "In the doorway, head below the lintel." } } };
    claim.mockResolvedValue(legacy); frames.mockResolvedValueOnce([]);
    await processAiVideo(s3, "media");
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move [Welcome home.]", undefined, undefined, true);
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
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("frames"), true, { onlyIf: { leaseToken: "mine", submitStartedAt: null } });
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
