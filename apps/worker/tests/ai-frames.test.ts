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
    expect(execute.mock.calls[0][2]).toMatchObject({ timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    expect(sign.mock.calls[0][1].input.Key).toBe("owned/a.mp4");
  });
  it("rejects an empty decode instead of sending a paid text-only generation", async () => {
    execute.mockResolvedValueOnce({ stdout: Buffer.alloc(0) });
    await expect(aiFrames({} as S3Client, "media", [{ key: "bad.mp4", kind: "VIDEO", atMs: 0 }])).rejects.toThrow("decoded");
  });
});
