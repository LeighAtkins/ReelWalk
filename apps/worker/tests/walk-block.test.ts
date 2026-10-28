import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockSolveKeyFor, blockStillKeyFor, initialPin, OUTPUT, parseBlockSolve, type BlockSolve } from "@reelwalk/core";
import { createAttemptScope } from "../src/lifecycle";

// Walk the block's worker steps (ADR 0093) with storage, the database and the Python solve stood in for.
const { db, sent, python } = vi.hoisted(() => ({
  db: { mediaAsset: { findFirst: vi.fn() } },
  sent: [] as { name: string; input: { Key?: string; ContentType?: string } }[],
  python: vi.fn(),
}));
vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("../src/library/tools", () => ({
  s3: {
    send: vi.fn(async (command: { constructor: { name: string }; input: { Key?: string } }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === "GetObjectCommand" ? { Body: Readable.from([Buffer.from("video")]) } : {};
    }),
  },
  run: (file: string, args: string[]) => python(file, args),
}));
import { blockRevealPayloadSchema, renderReveal, runBlockSolveStep, scopeFor, sourceRect, type FfmpegCommand } from "../src/walk-block";

beforeEach(() => {
  sent.length = 0;
  db.mediaAsset.findFirst.mockReset();
  python.mockReset();
});

describe("block-solve step", () => {
  it("stores a refusal, without a still, and hands the reason back for the person", async () => {
    db.mediaAsset.findFirst.mockResolvedValue({ id: "clip1", objectKey: "uploads/w/clip1.mp4", fileName: "drone.mp4" });
    python.mockImplementation(async (_file: string, args: string[]) => {
      const out = args[2];
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "solve.json"), JSON.stringify({ version: 1, ok: false, code: "no-parallax", message: "The drone turns on the spot." }));
      return { stdout: "refused: no-parallax\n", stderr: "" };
    });
    const result = await runBlockSolveStep({ payload: { assetId: "clip1" }, user: { workspaceId: "w" } });
    expect(result).toEqual({ ok: false, code: "no-parallax", message: "The drone turns on the spot." });
    const puts = sent.filter((s) => s.name === "PutObjectCommand").map((s) => s.input.Key);
    expect(puts).toEqual([blockSolveKeyFor("clip1")]);
    expect(puts).not.toContain(blockStillKeyFor("clip1"));
    // the clip is found only in the workspace or the shared library
    expect(db.mediaAsset.findFirst.mock.calls[0][0].where).toMatchObject({ id: "clip1", kind: "VIDEO", OR: [{ workspaceId: "w" }, { shared: true }] });
  });

  it("refuses a clip from another workspace before downloading anything", async () => {
    db.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(runBlockSolveStep({ payload: { assetId: "clip1" }, user: { workspaceId: "w" } })).rejects.toThrow("not in this workspace");
    expect(sent).toEqual([]);
    expect(python).not.toHaveBeenCalled();
  });
});

describe("block-reveal payload", () => {
  const pin = { build: "home", x: -30, z: -200, yawDeg: 50, length: 24, width: 11, cropX: 0.3, sun: { azimuthDeg: 135, elevationDeg: 35 }, scale: { factor: 1.5, basis: "stated" } };
  it("takes a pin and refuses a broken one", () => {
    expect(blockRevealPayloadSchema.safeParse({ assetId: "a", pin }).success).toBe(true);
    expect(blockRevealPayloadSchema.safeParse({ assetId: "a", pin: { ...pin, length: 0 } }).success).toBe(false);
    expect(blockRevealPayloadSchema.safeParse({ assetId: "a", pin: { ...pin, build: "castle" } }).success).toBe(false);
  });
});

describe("the crop", () => {
  it("takes whole source pixels at 9:16 inside the frame and says which window that is", () => {
    const decoded = { width: 3840, height: 2160 };
    const { rect, window } = sourceRect({ x: 300.3, y: 10.7, w: 523.9, h: 931.4 }, 2, decoded);
    expect(Number.isInteger(rect.left) && Number.isInteger(rect.top) && Number.isInteger(rect.width) && Number.isInteger(rect.height)).toBe(true);
    expect(rect.width / rect.height).toBeCloseTo(OUTPUT.width / OUTPUT.height, 2);
    expect(rect.left + rect.width).toBeLessThanOrEqual(decoded.width);
    expect(rect.top + rect.height).toBeLessThanOrEqual(decoded.height);
    expect(window.x).toBeCloseTo(rect.left / 2, 9);
    // a window past the edge is pulled back in
    const edge = sourceRect({ x: 1700, y: 0, w: 607.5, h: 1080 }, 2, decoded);
    expect(edge.rect.left + edge.rect.width).toBe(3840);
  });
});

describe("scopeFor", () => {
  it("stops the step's scope with the attempt and releases what it holds at once", async () => {
    const controller = new AbortController();
    const scope = scopeFor(controller.signal);
    const killed = vi.fn();
    scope.own("an ffmpeg", killed);
    expect(scope.signal.aborted).toBe(false);
    controller.abort(new Error("deadline"));
    expect(scope.signal.aborted).toBe(true);
    // released when the parent fires, not when the step's work next gets round to closing its scope
    await vi.waitFor(() => expect(killed).toHaveBeenCalledTimes(1));
    await scope.close();
    expect(killed).toHaveBeenCalledTimes(1);
  });
});

describe("renderReveal's processes", () => {
  // The real clip's solve, but the source made tiny (64 x 36), 4.6 s long at 1 fps: a 4-frame reveal. Each frame is
  // still composited at 1080 x 1920, so this stays small and leaves the CI runner's CPU to the other suites.
  const raw = JSON.parse(readFileSync(path.join(__dirname, "../../../packages/core/tests/fixtures/block-solve-14194694.json"), "utf8"));
  const parsed = parseBlockSolve({ ...raw, source: { ...raw.source, width: 64, height: 36, fps: 1, durationMs: 4600 } });
  if (!parsed.ok) throw new Error("fixture does not parse");
  const solve: BlockSolve = parsed.solve;
  const pin = initialPin(solve, "home");
  const fake = { file: process.execPath, prefix: [path.join(__dirname, "fixtures", "fake-ffmpeg.mjs")] };
  const quiet = () => undefined;

  async function attempt(env: Record<string, string>, ffmpeg: FfmpegCommand = fake) {
    Object.assign(process.env, env);
    const dir = await mkdtemp(path.join(tmpdir(), "reveal-test-"));
    const scope = createAttemptScope();
    try {
      return await renderReveal({ videoPath: "clip.mp4", solve, pin, outPath: path.join(dir, "out.mp4"), scope, log: quiet, ffmpeg }).then(async (r) => ({ ...r, file: await readFile(path.join(dir, "out.mp4"), "utf8") }));
    } finally {
      await scope.close();
      await rm(dir, { recursive: true, force: true });
      delete process.env.FAKE_ENCODE;
      delete process.env.FAKE_DECODE_FRAMES;
    }
  }

  it("draws every frame of the reveal at the source's rate", async () => {
    const done = await attempt({ FAKE_ENCODE: "ok", FAKE_DECODE_FRAMES: "1000" });
    expect(done.frames).toBe(4);
    expect(done.file).toBe("frames 4");
  }, 30_000);

  it("fails, without an unhandled rejection, when the encoder dies mid-stream", async () => {
    await expect(attempt({ FAKE_ENCODE: "die", FAKE_DECODE_FRAMES: "1000" })).rejects.toThrow(/ffmpeg encode exited 1/);
  }, 30_000);

  it("refuses footage that ends before the reveal does", async () => {
    await expect(attempt({ FAKE_ENCODE: "ok", FAKE_DECODE_FRAMES: "2" })).rejects.toThrow(/ended early: 2 of 4 frames/);
  }, 30_000);

  it("fails cleanly when ffmpeg cannot be started", async () => {
    await expect(attempt({}, { file: path.join(tmpdir(), "no-such-ffmpeg-here") })).rejects.toThrow(/ENOENT|ffmpeg/);
  }, 30_000);
});
