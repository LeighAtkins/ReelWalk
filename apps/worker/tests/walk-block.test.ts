import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockSolveKeyFor, blockStillKeyFor, initialPin, OUTPUT, parseBlockSolve, type BlockSolve } from "@reelwalk/core";
import { createAttemptScope } from "../src/lifecycle";

// Walk the block's worker steps (ADR 0093) with storage, the database and the Python solve stood in for.
const { db, sent, python, hooks } = vi.hoisted(() => ({
  db: { mediaAsset: { findFirst: vi.fn() } },
  sent: [] as { name: string; input: { Key?: string; ContentType?: string; Body?: unknown } }[],
  python: vi.fn(),
  /** Runs inside s3.send, before it answers: a test's chance to act while a request is in flight. */
  hooks: { onSend: null as null | ((name: string) => Promise<void>) },
}));
vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("../src/library/tools", () => ({
  s3: {
    send: vi.fn(async (command: { constructor: { name: string }; input: { Key?: string } }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      await hooks.onSend?.(command.constructor.name);
      return command.constructor.name === "GetObjectCommand" ? { Body: Readable.from([Buffer.from("video")]) } : {};
    }),
  },
  run: (file: string, args: string[], options: unknown) => python(file, args, options),
}));
import { solveLimits, stepDeadlineSeconds } from "../src/walk-block";
import { blockRevealPayloadSchema, renderReveal, revealDecodeArgs, runBlockSolveStep, runInStepScope, scopeFor, sourceRect, upload, type FfmpegCommand } from "../src/walk-block";

beforeEach(() => {
  hooks.onSend = null;
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

describe("solveLimits", () => {
  it("counts from the step's start, so a slow download leaves the solve less time, never past the step's deadline", () => {
    const start = 1_000_000;
    // straight away: killed at 9 min, its own budget at the 420 s cap
    expect(solveLimits(start, start, 600)).toEqual({ timeoutMs: 540_000, budgetS: 420 });
    // 3 min of download: 6 min left before the kill, the budget 30 s inside that
    expect(solveLimits(start, start + 180_000, 600)).toEqual({ timeoutMs: 360_000, budgetS: 330 });
    // a download that ends at 598 s: nothing is started (no minimum is ever added past the deadline)
    expect(solveLimits(start, start + 598_000, 600)).toBeNull();
    expect(solveLimits(start, start + 495_000, 600)).toBeNull(); // 45 s left before the kill: a 15 s budget, under the 20 s worth starting
    expect(solveLimits(start, start + 480_000, 600)).toEqual({ timeoutMs: 60_000, budgetS: 30 });
    // never more time than is left, whatever is left
    for (const elapsed of [0, 100_000, 300_000, 450_000, 489_000]) {
      const limits = solveLimits(start, start + elapsed, 600);
      if (limits) expect(start + elapsed + limits.timeoutMs).toBeLessThanOrEqual(start + 540_000);
    }
    // the configured step deadline, not an assumed 600 s
    expect(solveLimits(start, start, 300)).toEqual({ timeoutMs: 240_000, budgetS: 210 });
    expect(stepDeadlineSeconds({ AI_STEP_TIMEOUT_SECONDS: "900" })).toBe(900);
    expect(stepDeadlineSeconds({})).toBe(600);
  });

  it("stops a step with too little time left without starting the solve", async () => {
    db.mediaAsset.findFirst.mockResolvedValue({ id: "clip1", objectKey: "uploads/w/clip1.mp4", fileName: "drone.mp4" });
    process.env.AI_STEP_TIMEOUT_SECONDS = "60";
    try {
      await expect(runBlockSolveStep({ payload: { assetId: "clip1" }, user: { workspaceId: "w" } })).rejects.toThrow(/could not finish in time/);
    } finally {
      delete process.env.AI_STEP_TIMEOUT_SECONDS;
    }
    expect(python).not.toHaveBeenCalled();
    expect(sent.filter((s) => s.name === "PutObjectCommand")).toEqual([]);
  });

  it("is what the solve step hands the Python process", async () => {
    db.mediaAsset.findFirst.mockResolvedValue({ id: "clip1", objectKey: "uploads/w/clip1.mp4", fileName: "drone.mp4" });
    python.mockImplementation(async (_file: string, args: string[]) => {
      await mkdir(args[2], { recursive: true });
      await writeFile(path.join(args[2], "solve.json"), JSON.stringify({ version: 1, ok: false, code: "no-parallax", message: "x" }));
      return { stdout: "", stderr: "" };
    });
    await runBlockSolveStep({ payload: { assetId: "clip1" }, user: { workspaceId: "w" } });
    const options = python.mock.calls[0][2] as { timeoutMs: number; env: Record<string, string> };
    expect(options.timeoutMs).toBeLessThanOrEqual(540_000);
    expect(options.timeoutMs).toBeGreaterThan(530_000);
    expect(Number(options.env.BLOCK_SOLVE_BUDGET_S)).toBeLessThanOrEqual(420);
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
  it("stops the step with the attempt but keeps its files until the step's work has settled", async () => {
    const controller = new AbortController();
    const scope = scopeFor(controller.signal);
    const dir = await scope.tempDir("scope-test-");
    const released = vi.fn();
    scope.own("a temp file in use", released);
    controller.abort(new Error("deadline"));
    expect(scope.signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // still there: an upload or a download may be opening it right now
    expect(existsSync(dir)).toBe(true);
    expect(released).not.toHaveBeenCalled();
    await scope.close();
    expect(released).toHaveBeenCalledTimes(1);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("runInStepScope", () => {
  it("closes a stopped step's scope after its grace even while its work never settles, and the late work writes nothing", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const hang = new Promise<void>((resolve) => (release = resolve));
    const write = vi.fn();
    let dir = "";
    const started = Date.now();
    const running = runInStepScope(controller.signal, async (scope) => {
      dir = await scope.tempDir("forced-close-");
      await hang; // a storage request that ignores its abort signal
      scope.throwIfStopped();
      write();
    }, 100);
    await vi.waitFor(() => expect(dir).not.toBe(""));
    controller.abort(new Error("deadline"));
    await expect(running).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(existsSync(dir)).toBe(false); // the temp dir is gone though the work is still pending
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(write).not.toHaveBeenCalled();
  });

  it("gives the solve step's stuck download the same: stop, clean up, and no writes when it finally answers", async () => {
    db.mediaAsset.findFirst.mockResolvedValue({ id: "clip1", objectKey: "uploads/w/clip1.mp4", fileName: "drone.mp4" });
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    hooks.onSend = async (name) => (name === "GetObjectCommand" ? answered : undefined);
    const controller = new AbortController();
    const running = runInStepScope(controller.signal, (scope) => runBlockSolveStep({ payload: { assetId: "clip1" }, user: { workspaceId: "w" } }, scope), 100);
    await vi.waitFor(() => expect(sent.some((s) => s.name === "GetObjectCommand")).toBe(true));
    controller.abort(new Error("deadline"));
    await expect(running).rejects.toThrow();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent.filter((s) => s.name === "PutObjectCommand")).toEqual([]);
    expect(python).not.toHaveBeenCalled();
  });

  it("returns the work's own result when it is not stopped", async () => {
    await expect(runInStepScope(undefined, async () => 7, 100)).resolves.toBe(7);
  });
});

describe("upload", () => {
  it("survives its file being removed while the request is in flight, with no stream left to fail", async () => {
    const scope = createAttemptScope();
    const dir = await scope.tempDir("upload-test-");
    const file = path.join(dir, "reveal.mp4");
    await writeFile(file, Buffer.alloc(4096, 7));
    // what an abort used to do: the temp dir goes while the upload is between its start and its stream's open
    hooks.onSend = async () => rm(dir, { recursive: true, force: true });
    await expect(upload("k/reveal.mp4", file, "video/mp4", scope)).resolves.toBe(4096);
    const body = sent.find((s) => s.input.Key === "k/reveal.mp4")?.input.Body;
    expect(Buffer.isBuffer(body)).toBe(true); // read whole first: no ReadStream to emit ENOENT later
    // and a file already gone is a plain rejection
    await expect(upload("k/gone.mp4", file, "video/mp4", scope)).rejects.toThrow(/ENOENT/);
    await scope.close();
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

  it("refuses an encoded reveal over the size cap before anything reads it whole", async () => {
    Object.assign(process.env, { FAKE_ENCODE: "ok", FAKE_DECODE_FRAMES: "1000" });
    const dir = await mkdtemp(path.join(tmpdir(), "reveal-cap-"));
    const scope = createAttemptScope();
    try {
      // the fake encoder writes "frames 4" (8 bytes)
      await expect(renderReveal({ videoPath: "clip.mp4", solve, pin, outPath: path.join(dir, "out.mp4"), scope, log: quiet, ffmpeg: fake, maxBytes: 4 })).rejects.toThrow(/over the/);
      await expect(renderReveal({ videoPath: "clip.mp4", solve, pin, outPath: path.join(dir, "out.mp4"), scope, log: quiet, ffmpeg: fake, maxBytes: 64 })).resolves.toMatchObject({ bytes: 8 });
    } finally {
      await scope.close();
      await rm(dir, { recursive: true, force: true });
      delete process.env.FAKE_ENCODE;
      delete process.env.FAKE_DECODE_FRAMES;
    }
  }, 30_000);

  it("kills a stuck decoder the moment the attempt is stopped", async () => {
    process.env.FAKE_DECODE_HANG = "1";
    const controller = new AbortController();
    const scope = scopeFor(controller.signal);
    const dir = await scope.tempDir("reveal-abort-");
    const started = Date.now();
    const rendering = renderReveal({ videoPath: "clip.mp4", solve, pin, outPath: path.join(dir, "out.mp4"), scope, log: quiet, ffmpeg: fake });
    setTimeout(() => controller.abort(new Error("deadline")), 300);
    await expect(rendering).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000); // a hung decoder never exits on its own
    delete process.env.FAKE_DECODE_HANG;
    await scope.close();
  }, 30_000);

  it("fails cleanly when ffmpeg cannot be started", async () => {
    await expect(attempt({}, { file: path.join(tmpdir(), "no-such-ffmpeg-here") })).rejects.toThrow(/ENOENT|ffmpeg/);
  }, 30_000);
});

describe("the reveal's decode", () => {
  // A variable-frame-rate clip: 40 frames at 10 fps (0-4 s), then 80 at 40 fps (4-6 s); each frame shows its index.
  // The reveal runs to the clip's end (6 s), across the change of rate.
  const raw = JSON.parse(readFileSync(path.join(__dirname, "../../../packages/core/tests/fixtures/block-solve-14194694.json"), "utf8"));
  const parsed = parseBlockSolve({ ...raw, source: { ...raw.source, width: 160, height: 90, fps: 30, durationMs: 6000 } });
  if (!parsed.ok) throw new Error("fixture does not parse");
  const solve: BlockSolve = parsed.solve;
  const size = { width: 160, height: 90 };

  it("resamples to a constant rate, at most 30 fps, and ends in source time", () => {
    const args = revealDecodeArgs(solve, "clip.mp4", size);
    expect(args.join(" ")).toContain("-ss 0 -i clip.mp4 -t 5.850"); // the clip's 6 s less the end margin
    expect(args[args.indexOf("-vf") + 1]).toMatch(/^fps=30,scale=160:90/);
    expect(args).not.toContain("passthrough");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("175");
    // a 120 fps source still gives a 30 fps reveal: 4x fewer frames and bytes than its own rate
    const fast = revealDecodeArgs({ ...solve, source: { ...solve.source, fps: 120 } }, "clip.mp4", size);
    expect(fast[fast.indexOf("-vf") + 1]).toMatch(/^fps=30,/);
    expect(fast[fast.indexOf("-frames:v") + 1]).toBe("175");
  });

  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  const haveFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;
  it.skipIf(!haveFfmpeg)("puts frame k of a variable-frame-rate clip at its source moment still.t + k / fps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vfr-test-"));
    try {
      const clip = path.join(dir, "vfr.mp4");
      const bits = 8;
      const frames = Buffer.alloc(120 * size.width * size.height);
      for (let k = 0; k < 120; k++)
        for (let y = 0; y < size.height; y++)
          for (let b = 0; b < bits; b++)
            if ((k >> b) & 1) frames.fill(255, k * size.width * size.height + y * size.width + (b * size.width) / bits, k * size.width * size.height + y * size.width + ((b + 1) * size.width) / bits);
      const made = spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${size.width}x${size.height}`, "-r", "40", "-i", "-",
        "-vf", "setpts='if(lt(N,40),N/10,4+(N-40)/40)/TB'", "-fps_mode", "vfr", "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", clip], { input: frames });
      expect(made.status).toBe(0);
      const out = spawnSync(ffmpeg, revealDecodeArgs(solve, clip, size), { maxBuffer: 300 * size.width * size.height * 3 });
      expect(out.status).toBe(0);
      const frameBytes = size.width * size.height * 3;
      const decoded = out.stdout.length / frameBytes;
      // all the frames renderReveal asks for, right to the end of the file (one short is the rounding it allows): 5.85 s
      // of source at 30 fps, not the clip's own 120 frames
      const wanted = Number(revealDecodeArgs(solve, clip, size)[revealDecodeArgs(solve, clip, size).indexOf("-frames:v") + 1]);
      expect(wanted).toBe(175);
      expect(decoded).toBeGreaterThanOrEqual(wanted - 1);
      expect(decoded).toBeLessThanOrEqual(wanted);
      const indexAt = (k: number) => {
        let n = 0;
        for (let b = 0; b < bits; b++) {
          const x = Math.round(((b + 0.5) * size.width) / bits);
          const at = k * frameBytes + (Math.round(size.height / 2) * size.width + x) * 3;
          if (out.stdout[at] > 127) n |= 1 << b;
        }
        return n;
      };
      for (const k of [0, 60, 110, 125, 150, decoded - 1]) {
        const t = k / 30;
        const expected = t < 4 ? t * 10 : 40 + (t - 4) * 40;
        expect(Math.abs(indexAt(k) - expected)).toBeLessThanOrEqual(1);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
