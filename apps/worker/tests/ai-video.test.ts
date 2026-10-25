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
vi.mock("../src/vertex-video", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/vertex-video")>();
  return { VertexError: original.VertexError, definitelyRejected: original.definitelyRejected, VertexVideo: class { submit = submit; poll = poll; } };
});
import { aiVideoTiming, processAiVideo, UNRESOLVED_MESSAGE } from "../src/ai-video";
import { VertexError } from "../src/vertex-video";
aiVideoTiming.saveBackoffMs = [0, 0, 0];
aiVideoTiming.composeRetryMs = [0, 0];

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
  identity.mockResolvedValue({ samePerson: true, confidence: 0.9, faceHeightPx: 240, eyesAndMouthRendered: true });
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
    // Provably unsent: the budget reservation is released too.
    expect(fail).toHaveBeenCalledWith(db, "prep", expect.stringContaining("interrupted"), true, { onlyIf: { status: "SUBMITTING", submitStartedAt: null, leaseUntil: { lt: expect.any(Date) } } });
  });
  // Round 2: after the fence, only a definite refusal is refunded.
  const unresolved = () => db.aiGeneration.updateMany.mock.calls.map(([args]) => args).filter(args => args.data.status === "UNRESOLVED");
  it("a submit timeout is UNRESOLVED with the held-credit message, never refunded", async () => {
    claim.mockResolvedValue(job); submit.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    await processAiVideo(s3, "media");
    expect(fail).not.toHaveBeenCalled();
    expect(unresolved()).toEqual([{ where: { id: "one", leaseToken: "mine", status: { in: ["SUBMITTING", "UNRESOLVED"] } }, data: { status: "UNRESOLVED", error: UNRESOLVED_MESSAGE } }]);
    expect(UNRESOLVED_MESSAGE).toBe("We couldn't confirm whether this take was made. Your credit is held; it won't be charged twice.");
  });
  it("recovery marked it UNRESOLVED, then the submit fails ambiguously (5xx, or 4xx without a rejection code): still held", async () => {
    claim.mockResolvedValue(job); submit.mockRejectedValueOnce(new VertexError("HTTP 503", 503, "UNAVAILABLE"));
    await processAiVideo(s3, "media");
    claim.mockResolvedValue(job); submit.mockRejectedValueOnce(new VertexError("HTTP 400", 400));
    await processAiVideo(s3, "media");
    expect(fail).not.toHaveBeenCalled();
    expect(unresolved()).toHaveLength(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it("a definite rejection (4xx with a rejection code, no operation) refunds the credit and budget", async () => {
    claim.mockResolvedValue(job); submit.mockRejectedValueOnce(new VertexError("HTTP 400 (INVALID_ARGUMENT)", 400, "INVALID_ARGUMENT"));
    await processAiVideo(s3, "media");
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("could not start"), true, { onlyIf: { leaseToken: "mine" } });
    expect(unresolved()).toHaveLength(0);
  });
  it("an operation that cannot be saved is retried without resubmitting", async () => {
    claim.mockResolvedValue(job);
    db.aiGeneration.updateMany.mockResolvedValueOnce({ count: 1 }) // the fence
      .mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ count: 1 });
    await processAiVideo(s3, "media");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(db.aiGeneration.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "RUNNING", operationName: "operation-one" }) }));
    expect(fail).not.toHaveBeenCalled();
  });
  it("an operation that never saves is held UNRESOLVED with its name, not refunded or resubmitted", async () => {
    claim.mockResolvedValue(job);
    db.aiGeneration.updateMany.mockResolvedValueOnce({ count: 1 }) // the fence
      .mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ count: 1 });
    await processAiVideo(s3, "media");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
    expect(unresolved()).toEqual([expect.objectContaining({ data: { status: "UNRESOLVED", error: UNRESOLVED_MESSAGE, operationName: "operation-one" } })]);
  });
  it("a speaking take is composed close and held to the 165 px speaking floor", async () => {
    claim.mockResolvedValue({ ...job, shot: { mode: "custom", first: { assetId: "real-a", atMs: 0 }, line: "Welcome home.", voice: "veo", compose: { presenterId: "kit", first: "Beside the island bench, waist above it." } } });
    frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: true, confidence: 0.95, faceHeightPx: 160, eyesAndMouthRendered: true });
    await processAiVideo(s3, "media");
    expect(identity.mock.calls[0][2]).toEqual({ minFacePx: 165 });
    expect(compose.mock.calls[0][5]).toEqual({ framing: "close", stronger: false });
    // 160 px would pass a silent take; a speaking one is recomposed.
    expect(compose).toHaveBeenCalledTimes(2);
    expect(compose.mock.calls[1][5]).toEqual({ framing: "close", stronger: true });
    compose.mockReset();
  });
  it.each([
    ["the locate never lands", { samePerson: false, confidence: 0, faceHeightPx: null, reason: "locate-failed" }, "We couldn't find her face clearly in the start frame"],
    ["her face is too small to speak", { samePerson: false, confidence: 0, faceHeightPx: 140, reason: "face-too-small" }, "Her face was too small to speak on camera (140 px; needs 165)"],
    ["her eyes or mouth are missing", { samePerson: true, confidence: 0.97, faceHeightPx: 200, eyesAndMouthRendered: false }, "Her eyes or mouth weren't clearly drawn in the start frame"],
    ["it is someone else", { samePerson: false, confidence: 0.12, faceHeightPx: 200, eyesAndMouthRendered: true }, "It didn't look like her (score 0.12)"],
  ])("the refund says why when %s", async (_label, verdict, message) => {
    claim.mockResolvedValue({ ...job, shot: { mode: "custom", first: { assetId: "real-a", atMs: 0 }, line: "Welcome home.", voice: "lipsync", compose: { presenterId: "kit", first: "Beside the island bench, waist above it." } } });
    frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValue(verdict);
    await processAiVideo(s3, "media");
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining(message), true, expect.objectContaining({ failureCode: "identity_rejected" }));
    expect(fail.mock.calls[0][2]).not.toContain("did not match");
    compose.mockReset(); identity.mockReset();
  });
  it("a shouted Veo line over a wide or action shot keeps its framing and the silent floor", async () => {
    claim.mockResolvedValue({ ...job, shot: { mode: "custom", first: { assetId: "real-a", atMs: 0 }, line: "Here we go!", voice: "veo", compose: { presenterId: "kit", first: "Wide: mid-action, leaping from the deck into the pool." } } });
    frames.mockResolvedValueOnce([{ ...kit[0], compose: "Wide: mid-action, leaping from the deck into the pool.", framing: "wide" }, kit[1], kit[2]]);
    compose.mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: true, confidence: 0.9, faceHeightPx: 130, eyesAndMouthRendered: true });
    await processAiVideo(s3, "media");
    expect(compose.mock.calls[0][5]).toEqual({ framing: "wide", stronger: false });
    expect(identity.mock.calls[0][2]).toEqual({ minFacePx: 120 });
    expect(submit).toHaveBeenCalledTimes(1);
    compose.mockReset();
  });
  it("a confident match whose eyes or mouth are not rendered is recomposed, then refused (cmvi0jk8h)", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValue({ samePerson: true, confidence: 0.98, faceHeightPx: 150, eyesAndMouthRendered: false });
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(db, "one", expect.any(String), true, expect.objectContaining({ failureCode: "identity_rejected",
      identityChecks: [expect.objectContaining({ eyesAndMouthRendered: false }), expect.objectContaining({ eyesAndMouthRendered: false })] }));
    compose.mockReset(); identity.mockReset();
  });
  it("a face too small to judge is recomposed a framing closer, even when wide was asked for, and the framing is on record", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce([{ ...kit[0], framing: "wide" }, kit[1], kit[2]]);
    compose.mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: false, confidence: 0, faceHeightPx: 58, reason: "face-too-small" }).mockResolvedValueOnce({ samePerson: true, confidence: 0.8, faceHeightPx: 240, eyesAndMouthRendered: true });
    await processAiVideo(s3, "media");
    expect(compose.mock.calls[0][5]).toEqual({ framing: "wide", stronger: false });
    expect(compose.mock.calls[1][5]).toEqual({ framing: "close", stronger: true, closer: true });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      identityChecks: [expect.objectContaining({ attempt: 1, framing: "wide", faceHeightPx: 58 }), expect.objectContaining({ attempt: 2, framing: "close", faceHeightPx: 240 })] }) }));
    compose.mockReset();
  });
  it("a speaking take at close framing escalates to tight after a face too small, cropping the plate again", async () => {
    claim.mockResolvedValue({ ...job, shot: { mode: "custom", first: { assetId: "real-a", atMs: 0 }, line: "Welcome home.", voice: "veo", compose: { presenterId: "kit", first: "Beside the island bench, waist above it.", framing: "close" } } });
    frames.mockResolvedValueOnce([{ ...kit[0], framing: "close", source: { key: "owned/kitchen.mp4", kind: "VIDEO", atMs: 1000 } }, kit[1], kit[2]]);
    compose.mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: false, confidence: 0, faceHeightPx: 150, reason: "face-too-small" }).mockResolvedValueOnce({ samePerson: true, confidence: 0.9, faceHeightPx: 430, eyesAndMouthRendered: true });
    await processAiVideo(s3, "media");
    expect(compose.mock.calls[0][5]).toEqual({ framing: "close", stronger: false });
    expect(compose.mock.calls[1][5]).toEqual({ framing: "tight", stronger: true, closer: true });
    expect(identity.mock.calls[0][2]).toEqual({ minFacePx: 165 });
    expect(submit).toHaveBeenCalledTimes(1);
    compose.mockReset();
  });
  const composed = [{ bytesBase64Encoded: "first", mimeType: "image/jpeg", role: "first", compose: "At the door, head below the lintel." }, { bytesBase64Encoded: "last", mimeType: "image/jpeg", role: "last" }, { bytesBase64Encoded: "her", mimeType: "image/jpeg", role: "presenter" }];
  it("composes a described start still with the presenter before submitting, and keeps a copy", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed);
    compose.mockResolvedValueOnce({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledWith("first", "At the door, head below the lintel.", { bytesBase64Encoded: "first", mimeType: "image/jpeg" }, { bytesBase64Encoded: "her", mimeType: "image/jpeg" }, undefined, { framing: "medium", stronger: false });
    // Without a kit the gate compares against the presenter frame itself.
    expect(identity).toHaveBeenCalledWith({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, { bytesBase64Encoded: "her", mimeType: "image/jpeg" }, { minFacePx: 120 });
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move", { bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, { bytesBase64Encoded: "last", mimeType: "image/jpeg" }, false);
    expect((s3.send as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command.input?.Key)).toContain("workspaces/studio/ai/one-first.jpg");
  });
  it("refunds when a still cannot be composed, before anything is paid, and says why", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed); compose.mockRejectedValue(new Error("Google did not return a composed frame."));
    await processAiVideo(s3, "media");
    expect(submit).not.toHaveBeenCalled();
    // A reply with no image is transient: every try on the schedule is used before the refund.
    expect(compose).toHaveBeenCalledTimes(1 + aiVideoTiming.composeRetryMs.length);
    expect(fail).toHaveBeenCalledWith(db, "one", "The start and end stills could not be composed (Google did not return a composed frame). Your credit was returned.", true,
      expect.objectContaining({ failureCode: "compose_failed", onlyIf: { leaseToken: "mine", submitStartedAt: null } }));
    compose.mockReset();
  });
  // D5 v2 (2026-10-23): the queue composed one take at a time, yet two of five still failed at compose. One transient answer was a refund.
  it("a rate-limited compose (HTTP 429) is tried again under the lease and the take goes on to Veo", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed);
    compose.mockRejectedValueOnce(new VertexError("Google image service returned HTTP 429.", 429, "RESOURCE_EXHAUSTED")).mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledTimes(2); // the first try and the retry; the last end of this fixture is not composed
    expect(fail).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    // The claim was renewed before the second try.
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "one", leaseToken: "mine", status: "SUBMITTING", submitStartedAt: null }, data: { leaseUntil: expect.any(Date) } }));
    compose.mockReset();
  });
  it("a refusal at compose (HTTP 400) is final: one try, refunded with the status", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed);
    compose.mockRejectedValueOnce(new VertexError("Google image service returned HTTP 400.", 400, "INVALID_ARGUMENT")).mockResolvedValue({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("(Google image service returned HTTP 400)"), true, expect.objectContaining({ failureCode: "compose_failed" }));
    compose.mockReset();
  });
  it("a claim lost between compose tries stops them without a refund", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(composed);
    compose.mockRejectedValue(new VertexError("Google image service returned HTTP 503.", 503));
    db.aiGeneration.updateMany.mockResolvedValue({ count: 0 }); // the renewal finds the row gone
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    compose.mockReset();
  });
  // ADR 0056: the kit's full-length still and face crop, and the identity gate before Veo is paid.
  const kit = [{ bytesBase64Encoded: "scene", mimeType: "image/png", role: "first", compose: "Beside the island bench, waist above it.", framing: "medium" }, { bytesBase64Encoded: "body", mimeType: "image/png", role: "presenter" }, { bytesBase64Encoded: "face", mimeType: "image/png", role: "face" }];
  const keys = () => (s3.send as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command.input?.Key);
  it("composes from the kit's full-length still and face crop, gates on her face, and records the score", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValueOnce({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: true, confidence: 0.82, faceHeightPx: 210, eyesAndMouthRendered: true, locate: [{ mode: "grid", box: [300, 400, 409, 500], crop: { x: 300, y: 500, size: 462 }, faceHeightPx: 210 }] });
    await processAiVideo(s3, "media");
    expect(compose).toHaveBeenCalledWith("first", "Beside the island bench, waist above it.", { bytesBase64Encoded: "scene", mimeType: "image/png" }, { bytesBase64Encoded: "body", mimeType: "image/png" }, { bytesBase64Encoded: "face", mimeType: "image/png" }, { framing: "medium", stronger: false });
    expect(identity).toHaveBeenCalledWith({ bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, { bytesBase64Encoded: "face", mimeType: "image/png" }, { minFacePx: 120 });
    expect(submit).toHaveBeenCalledWith("veo", 8, "Move", { bytesBase64Encoded: "composed", mimeType: "image/jpeg" }, undefined, false);
    expect(db.aiGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "RUNNING", identityScore: 0.82,
      identityChecks: [{ end: "first", attempt: 1, samePerson: true, confidence: 0.82, faceHeightPx: 210, minFacePx: 120, framing: "medium", eyesAndMouthRendered: true,
      // The locate box and crop are kept on every check, so a false reject can be diagnosed from the database.
      locate: [{ mode: "grid", box: [300, 400, 409, 500], crop: { x: 300, y: 500, size: 462 }, faceHeightPx: 210 }] }] }) }));
  });
  it("recomposes once with a stronger instruction when the face misses, then pays only for the match", async () => {
    claim.mockResolvedValue(job); frames.mockResolvedValueOnce(kit);
    compose.mockResolvedValueOnce({ bytesBase64Encoded: "drifted", mimeType: "image/jpeg" }).mockResolvedValueOnce({ bytesBase64Encoded: "her-again", mimeType: "image/jpeg" });
    identity.mockResolvedValueOnce({ samePerson: false, confidence: 0.3, faceHeightPx: 64 }).mockResolvedValueOnce({ samePerson: true, confidence: 0.7, faceHeightPx: 230, eyesAndMouthRendered: true });
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
    expect(fail).toHaveBeenCalledWith(db, "one", "It didn't look like her (score 0.55), so the shot was not made. Your credit was returned.", true, expect.objectContaining({ failureCode: "identity_rejected", identityScore: 0.4,
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
    expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("We couldn't check her face in the start frame"), true, expect.objectContaining({ failureCode: "identity_rejected" }));
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
  // Draft tier (ADR 0076): a preview on the Lite model, 720p, silent, and the same seed on its final.
  describe("draft tier", () => {
    const draftShot = { mode: "custom", move: "orbit", first: { assetId: "real-a", atMs: 0 }, tier: "draft", seed: 99, line: "Welcome home.", voice: "lipsync" };
    const draftJob = { ...job, model: "veo-3.1-lite-generate-001", durationSeconds: 4, shot: draftShot };
    it("submits on the draft model with the seed, and a spoken line waits for the final", async () => {
      claim.mockResolvedValue(draftJob);
      await processAiVideo(s3, "media");
      // The line is not voiced in a draft: the prompt is the plain one and Veo is asked for no audio.
      expect(submit).toHaveBeenCalledWith("veo-3.1-lite-generate-001", 4, "Move", expect.anything(), expect.anything(), false, 99);
    });
    it("sends the same seed on the final, and the voice with it", async () => {
      claim.mockResolvedValue({ ...draftJob, model: "veo", shot: { ...draftShot, tier: "final", finalOf: "draft-one" } });
      await processAiVideo(s3, "media");
      expect(submit).toHaveBeenCalledWith("veo", 4, "Move [Welcome home.]", expect.anything(), expect.anything(), false, 99);
    });
    it("stores a finished draft as a 720p draft in the library", async () => {
      claim.mockResolvedValue({ ...draftJob, status: "RUNNING" });
      await processAiVideo(s3, "media");
      expect(tx.mediaAsset.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ fileName: expect.stringMatching(/^AI draft — /), width: 720, height: 1280 }) }));
    });
    it("refunds a draft the provider refuses outright, credit and budget together", async () => {
      claim.mockResolvedValue(draftJob); submit.mockRejectedValueOnce(new VertexError("HTTP 404 (NOT_FOUND)", 404, "NOT_FOUND"));
      await processAiVideo(s3, "media");
      expect(fail).toHaveBeenCalledWith(db, "one", expect.stringContaining("Your credit was returned"), true, { onlyIf: { leaseToken: "mine" } });
    });
    it("holds a draft whose submission is unknown, never refunds or resends it", async () => {
      claim.mockResolvedValue(draftJob); submit.mockRejectedValueOnce(new Error("timeout"));
      await processAiVideo(s3, "media");
      expect(fail).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
    });
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
