import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_SERIES, type ReferenceAnalysis } from "@reelwalk/core";
import { createAttemptScope } from "../src/lifecycle";

// The "reference-read" step (ADR 0102) with ffmpeg, the beat reader, storage, the database and the model stood in for.
// ffmpeg answers the scene filter with the reference's own cuts (1.8 s, a flash at 1.87 s, 9.73 s), the grey decode
// with still frames, and each keyframe grab with a small JPEG; storage keeps what was put, as S3 does.
const { db, store, calls, reader } = vi.hoisted(() => ({
  db: { styleReference: { findFirst: vi.fn(), updateMany: vi.fn() } },
  store: new Map<string, Buffer>(),
  calls: [] as string[],
  reader: vi.fn(),
}));
vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("../src/config", () => ({ getConfig: () => ({ s3Bucket: "bucket" }) }));
vi.mock("../src/transcribe", () => ({ transcriptionAvailable: () => false, transcribeVideo: vi.fn() }));
vi.mock("../src/library/tools", () => ({
  decodeMono: vi.fn(async () => new Float32Array(0)),
  s3: {
    send: vi.fn(async (command: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) => {
      const { Key } = command.input;
      if (command.constructor.name === "GetObjectCommand") {
        calls.push(`get ${Key}`);
        const body = store.get(Key);
        if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: Object.assign(Readable.from(body), { transformToByteArray: async () => new Uint8Array(body) }) };
      }
      calls.push(`put ${Key}`);
      store.set(Key, Buffer.from(command.input.Body ?? Buffer.alloc(0)));
      return {};
    }),
  },
  run: vi.fn(async (_file: string, args: string[]) => {
    if (args.some((a) => a.includes("scene"))) {
      calls.push("ffmpeg scene");
      return { stdout: "", stderr: ["pts_time:1.8 ", "pts_time:1.86667 ", "pts_time:9.73333 "].join("\n") };
    }
    if (args.includes("rawvideo")) {
      calls.push("ffmpeg grey");
      const { width, height } = CHECK_SERIES;
      return { stdout: Buffer.alloc(width * height * 30, 128), stderr: Buffer.alloc(0) };
    }
    calls.push("ffmpeg keyframe");
    await writeFile(args.at(-1)!, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { stdout: "", stderr: "" };
  }),
}));

import { keyframeKey, runReferenceReadStep } from "../src/reference-read";

const WORKSPACE = "ws1";
const step = { payload: { referenceId: "ref1" }, user: { workspaceId: WORKSPACE } };
const asset = { objectKey: "uploads/ref.mp4", kind: "VIDEO", durationMs: 13_775, width: 1080, height: 1920, transcript: { text: "Instead of typing", words: [{ w: "Instead", s: 0, e: 300 }, { w: "of", s: 300, e: 400 }] } };
const reading = { format: "A talking head, then a grid of demo tiles.", notes: [], titles: [{ text: "dot hop", startMs: 1900, endMs: 3200, effect: "dotHop" as const }] };

const writes = () => db.styleReference.updateMany.mock.calls.map(([arg]) => arg.data as { status: string; analysis?: ReferenceAnalysis; recipe?: { titles: unknown[]; pacing: { firstCutMs: number } }; error?: string | null });

describe("runReferenceReadStep", () => {
  let scope: ReturnType<typeof createAttemptScope>;
  beforeEach(() => {
    scope = createAttemptScope();
    store.clear();
    calls.length = 0;
    db.styleReference.updateMany.mockReset().mockResolvedValue({ count: 1 });
    db.styleReference.findFirst.mockReset();
    reader.mockReset().mockResolvedValue({ read: reading, model: "claude-test" });
    store.set(asset.objectKey, Buffer.from("video"));
  });
  afterEach(async () => { await scope.close(); });

  it("measures, saves the keyframes and the analysis before the paid reading, then saves the recipe", async () => {
    db.styleReference.findFirst.mockResolvedValue({ id: "ref1", analysis: null, mediaAsset: asset });
    const result = await runReferenceReadStep(step, scope, reader, () => {});
    expect(result).toEqual({ referenceId: "ref1", status: "ready", titles: 1, shots: 3 });

    const [measured, ready] = writes();
    expect(measured.status).toBe("reading");
    expect(measured.analysis!.shots.map((s) => [s.startMs, s.endMs])).toEqual([[0, 1800], [1800, 9733], [9733, 13_775]]);
    // The upload's own transcript is used; nothing is transcribed again.
    expect(measured.analysis!.words).toEqual([{ text: "Instead", startMs: 0, endMs: 300 }, { text: "of", startMs: 300, endMs: 400 }]);
    expect(measured.analysis!.keyframes[0]).toEqual({ atMs: 0, key: keyframeKey(WORKSPACE, "ref1", 0) });
    expect(ready).toMatchObject({ status: "ready", error: null });
    expect(ready.recipe!.pacing.firstCutMs).toBe(1800);
    expect(ready.recipe!.titles).toHaveLength(1);

    // One reading, with every saved keyframe as an image, after the analysis was written.
    expect(reader).toHaveBeenCalledTimes(1);
    const input = reader.mock.calls[0][0];
    expect(input.workspaceId).toBe(WORKSPACE);
    expect(input.frames).toHaveLength(measured.analysis!.keyframes.length);
    expect(input.frames[0].dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(db.styleReference.updateMany.mock.invocationCallOrder[0]).toBeLessThan(reader.mock.invocationCallOrder[0]);
  });

  it("reads again from the saved analysis without downloading or measuring the reel", async () => {
    db.styleReference.findFirst.mockResolvedValue({ id: "ref1", analysis: null, mediaAsset: asset });
    reader.mockRejectedValueOnce(new Error("The model refused the request: overloaded"));
    await expect(runReferenceReadStep(step, scope, reader, () => {})).rejects.toThrow("overloaded");
    const saved = writes()[0].analysis!;
    expect(writes().at(-1)).toMatchObject({ status: "failed", error: "The model refused the request: overloaded" });

    calls.length = 0;
    db.styleReference.updateMany.mockClear();
    db.styleReference.findFirst.mockResolvedValue({ id: "ref1", analysis: saved, mediaAsset: asset });
    await runReferenceReadStep(step, scope, reader, () => {});
    expect(calls.some((c) => c.startsWith("ffmpeg") || c === `get ${asset.objectKey}`)).toBe(false);
    expect(writes().map((w) => w.status)).toEqual(["ready"]);
  });

  it("refuses a reference from another workspace or one that is not a video", async () => {
    db.styleReference.findFirst.mockResolvedValue(null);
    await expect(runReferenceReadStep(step, scope, reader, () => {})).rejects.toThrow("not in this workspace");
    db.styleReference.findFirst.mockResolvedValue({ id: "ref1", analysis: null, mediaAsset: { ...asset, kind: "IMAGE" } });
    await expect(runReferenceReadStep(step, scope, reader, () => {})).rejects.toThrow("has to be a video");
    expect(reader).not.toHaveBeenCalled();
    expect(db.styleReference.findFirst.mock.calls[0][0].where).toEqual({ id: "ref1", workspaceId: WORKSPACE });
  });
});
