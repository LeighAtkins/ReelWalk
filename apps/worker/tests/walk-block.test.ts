import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockSolveKeyFor, blockStillKeyFor, OUTPUT } from "@reelwalk/core";

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
import { blockRevealPayloadSchema, runBlockSolveStep, scopeFor, sourceRect } from "../src/walk-block";

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
  it("stops the step's scope with the attempt", () => {
    const controller = new AbortController();
    const scope = scopeFor(controller.signal);
    expect(scope.signal.aborted).toBe(false);
    controller.abort(new Error("deadline"));
    expect(scope.signal.aborted).toBe(true);
    void scope.close();
  });
});
