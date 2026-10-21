import { describe, expect, it, vi } from "vitest";
const { execute, sign } = vi.hoisted(() => ({ execute: vi.fn(), sign: vi.fn().mockResolvedValue("https://storage.test/private-frame") }));
vi.mock("node:child_process", () => ({ execFile: execute }));
vi.mock("node:util", () => ({ promisify: () => execute }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: sign }));
import { aiFrames } from "../src/ai-frames";
import type { S3Client } from "@aws-sdk/client-s3";

describe("AI reference frames", () => {
  it("seeks the two source timestamps and returns separate JPEG images", async () => {
    execute.mockResolvedValue({ stdout: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200)]) });
    const frames = await aiFrames({} as S3Client, "media", [
      { key: "owned/a.mp4", kind: "VIDEO", atMs: 6933 }, { key: "owned/b.mp4", kind: "VIDEO", atMs: 2300 },
    ]);
    expect(frames).toHaveLength(2);
    expect(frames[0].mimeType).toBe("image/jpeg");
    expect(execute.mock.calls[0][1]).toContain("6.933");
    expect(execute.mock.calls[1][1]).toContain("2.300");
    expect(execute.mock.calls[0][2]).toMatchObject({ timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    expect(sign.mock.calls[0][1].input.Key).toBe("owned/a.mp4");
  });
  it("rejects an empty decode instead of sending a paid text-only generation", async () => {
    execute.mockResolvedValueOnce({ stdout: Buffer.alloc(0) });
    await expect(aiFrames({} as S3Client, "media", [{ key: "bad.mp4", kind: "VIDEO", atMs: 0 }])).rejects.toThrow("decoded");
  });
  // ADR 0056: what the image model reads is PNG; only a frame Veo sees as-is is a 4:2:0 JPEG.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  it("decodes a scene to compose, the presenter and her face crop as PNG, references unscaled and uncropped", async () => {
    execute.mockReset().mockResolvedValue({ stdout: png });
    const frames = await aiFrames({} as S3Client, "media", [
      { key: "owned/kitchen.mp4", kind: "VIDEO", atMs: 1000, role: "first", compose: "Beside the island bench, waist above it.", framing: "medium" },
      { key: "uploads/w/full.png", kind: "IMAGE", atMs: 0, role: "presenter" },
      { key: "workspaces/w/presenters/p/face.png", kind: "IMAGE", atMs: 0, role: "face" },
    ]);
    expect(frames.map(frame => [frame.role, frame.mimeType])).toEqual([["first", "image/png"], ["presenter", "image/png"], ["face", "image/png"]]);
    expect(frames[0]).toMatchObject({ compose: "Beside the island bench, waist above it.", framing: "medium" });
    const [scene, presenter] = execute.mock.calls.map(call => call[1].join(" "));
    expect(scene).toContain("crop=1080:1920"); expect(scene).toContain("-vcodec png -pix_fmt rgb24");
    expect(presenter).not.toContain("crop="); expect(presenter).toContain("min(1080,iw)");
    expect(execute.mock.calls.every(call => !call[1].includes("yuvj420p"))).toBe(true);
  });
  it("refuses a JPEG where a PNG reference was asked for", async () => {
    execute.mockReset().mockResolvedValue({ stdout: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200)]) });
    await expect(aiFrames({} as S3Client, "media", [{ key: "face.png", kind: "IMAGE", atMs: 0, role: "face" }])).rejects.toThrow("decoded");
  });
});
