import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_SERIES, parseTimeline } from "@reelwalk/core";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/library/tools", () => ({ run }));

import { verifyRender } from "../src/verify";

// The render checks after an export (ADR 0071): ffmpeg's grey decode read as frames, the checks
// computed against the rendered timeline, and the log line the worker writes.

const { width, height, fps } = CHECK_SERIES;
const size = width * height;

/** `seconds` of frames: black for the first `blackMs`, then a textured picture that drifts slowly. */
function greyStream(durationMs: number, blackMs: number): Buffer {
  const frames = Math.round((durationMs / 1000) * fps);
  const bytes = Buffer.alloc(frames * size);
  for (let n = 0; n < frames; n++) {
    const ms = (n * 1000) / fps;
    for (let i = 0; i < size; i++) {
      const x = i % width, y = Math.floor(i / width);
      bytes[n * size + i] = ms < blackMs ? 0 : Math.round(120 + 60 * Math.sin((x + ms / 40) * 0.3) + 40 * Math.cos(y * 0.2));
    }
  }
  return bytes;
}

const timeline = parseTimeline({
  version: 1,
  clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, volume: 0 }],
  texts: [],
  music: null,
});

describe("verifyRender", () => {
  beforeEach(() => run.mockReset());

  it("decodes the file to grey frames with ffmpeg and finds a black opening", async () => {
    run.mockResolvedValue({ stdout: greyStream(3000, 500), stderr: Buffer.alloc(0) });
    const lines: string[] = [];
    const checks = await verifyRender("/tmp/out.mp4", timeline, (line) => lines.push(line));
    expect(run).toHaveBeenCalledTimes(1);
    const [binary, args, options] = run.mock.calls[0];
    expect(binary).toBe("ffmpeg");
    expect(args).toContain("/tmp/out.mp4");
    expect(args.join(" ")).toContain(`scale=${width}:${height},format=gray -r ${fps} -f image2pipe -vcodec rawvideo -`);
    expect(options).toMatchObject({ encoding: "buffer" });
    expect(checks.facts.frames).toEqual({ count: 90, stepMs: Math.round(1000 / fps) });
    expect(checks.facts.openingBlack).toBe(true);
    expect(checks.blocked).toBe(true);
    expect(checks.checks.map((check) => check.id)).toContain("empty-opening");
    expect(lines[0]).toMatch(/^checks: 90 frames read in [\d.]+ s; \d+ finding\(s\), [1-9]\d* blocking: /);
  });

  it("passes a clean render with the frames counted", async () => {
    run.mockResolvedValue({ stdout: greyStream(3000, 0), stderr: Buffer.alloc(0) });
    const checks = await verifyRender("/tmp/out.mp4", timeline, () => undefined);
    expect(checks.blocked).toBe(false);
    expect(checks.facts.openingBlack).toBe(false);
    expect(checks.facts.motionPerSecond.length).toBe(3);
  });
});
