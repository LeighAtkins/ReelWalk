import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  areaText,
  blockPinSchema,
  blockSolveKeyFor,
  blockStillKeyFor,
  blockSvg,
  BUILDS,
  clipSchema,
  drawBlock,
  emptyTimeline,
  labelImageSize,
  OUTPUT,
  parseBlockSolve,
  revealDurationMs,
  revealFps,
  textSchema,
  viewAt,
  type BlockPin,
  type BlockSolve,
  type BlockShape,
  type ViewWindow,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import sharp from "sharp";
import { z } from "zod";
import { getConfig } from "./config";
import { run, s3 } from "./library/tools";
import { AttemptStopped, createAttemptScope, killTree, ownChild, OWN_PROCESS_GROUP, type AttemptScope } from "./lifecycle";

/**
 * Walk the block (ADR 0093), the worker's half. Two durable steps, neither calls a paid provider:
 *
 * - "block-solve": the drone clip read in 3D by `block/run.py` (OpenCV; Python because that is where the method was
 *   proven, 76 of 76 frames at 0.29 px where COLMAP failed). The solve and the pin screen's still are kept in storage
 *   beside nothing else (`blockSolveKeyFor`), so asking again for the same clip reads them back.
 * - "block-reveal": the reveal clip drawn frame by frame: the true-scale outline locked to the ground, its area written
 *   on it, then the white massing rising with its shadow. The shapes come from `drawBlock` in core, the same function
 *   the pin screen draws with; here they are rasterised onto each decoded frame. No Veo: a generator does not hold scale.
 *   The clip becomes a media asset and the first shot of a new reel.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The solve's Python package. In the image it runs from the venv at /opt/block (Dockerfile); locally from any python with opencv. */
export const BLOCK_DIR = path.resolve(HERE, "..", "block");
const PYTHON = process.env.BLOCK_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const LABEL_FONT_FILE = path.join(BLOCK_DIR, "fonts", "PlayfairDisplay.ttf");

export const blockSolvePayloadSchema = z.object({ assetId: z.string().min(1).max(64) });
export const blockRevealPayloadSchema = z.object({ assetId: z.string().min(1).max(64), pin: blockPinSchema });

export type BlockSolveStepResult = { ok: true; frames: number; registered: number; medianReprojectionPx: number } | { ok: false; code: string; message: string };
export type BlockRevealStepResult = { assetId: string; reelId: string };

type Log = (line: string) => void;

/**
 * An attempt scope for a step, stopped when the step's own attempt is (the executor hands steps its signal, not its
 * scope). When that signal fires, the scope is aborted: every process the step runs is killed at once (ffmpeg by
 * `spawnOwned`'s abort listener, Python by `run`'s), and storage requests abort through the signal. The scope is NOT
 * closed then: its temp dirs are removed by the step's own `close()`, after its work has settled, so nothing still
 * reading or writing a file there (an upload opening it, a download writing it) has it deleted underneath (review
 * round 2: removing a file between an upload's stat and its stream's open was an unhandled ENOENT that killed the worker).
 */
export function scopeFor(signal: AbortSignal | undefined): AttemptScope {
  const scope = createAttemptScope();
  const stop = () => scope.abort(signal?.reason instanceof AttemptStopped ? signal.reason : new AttemptStopped("The step was stopped", "shutdown"));
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  return scope;
}

/**
 * How long a stopped step's work may take to unwind before its scope is closed under it: below the outer attempt's
 * grace (`DEFAULT_GRACE_MS`, 10 s), so the step's processes and files are gone before the attempt is given up on.
 */
export const STEP_FORCE_CLOSE_MS = 5_000;

/**
 * Runs a step's work in its own scope (`scopeFor`). Normally the scope is closed when the work settles. When the
 * attempt is stopped and the work has not settled `graceMs` later (a storage request that ignores its abort signal,
 * say), the scope is closed anyway: its processes killed, its temp dirs removed, and this returns the stop at once, so
 * nothing the step held outlives the attempt and a retry cannot run beside it. The work's late settling is then
 * harmless: every write it makes (`upload`, the stored solve, the asset and reel rows) first checks the stopped scope.
 */
export async function runInStepScope<T>(signal: AbortSignal | undefined, work: (scope: AttemptScope) => Promise<T>, graceMs = STEP_FORCE_CLOSE_MS): Promise<T> {
  const scope = scopeFor(signal);
  const running = work(scope);
  running.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forced = new Promise<never>((_, reject) => {
    const arm = () => {
      timer = setTimeout(() => {
        void scope.close();
        reject(scope.signal.reason instanceof Error ? scope.signal.reason : new AttemptStopped("The step was stopped", "deadline"));
      }, graceMs);
    };
    if (scope.signal.aborted) arm();
    else scope.signal.addEventListener("abort", arm, { once: true });
  });
  forced.catch(() => undefined);
  try {
    return await Promise.race([running, forced]);
  } finally {
    clearTimeout(timer);
    await scope.close();
  }
}

/**
 * The step's own deadline: the worker's AI_STEP_TIMEOUT_SECONDS (index.ts reads the same variable, 600 by default),
 * the headroom kept under it for the uploads, the margin between run.py's budget and its kill, and the least time
 * worth starting a solve with.
 */
export function stepDeadlineSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AI_STEP_TIMEOUT_SECONDS ?? 600);
  return Number.isFinite(n) && n > 0 ? n : 600;
}
const SOLVE_HEADROOM_S = 60;
const SOLVE_MARGIN_S = 30;
const SOLVE_BUDGET_S = 420;
const SOLVE_MIN_BUDGET_S = 20;

/**
 * How long the solve may still run, measured from the step's start (the download counts against it), or null when
 * too little is left to be worth starting: the Python process is killed `SOLVE_HEADROOM_S` before the step's deadline,
 * and run.py's own budget (after which it refuses the clip as "too-slow" and says so) ends `SOLVE_MARGIN_S` before
 * that, at most 420 s. Never more than what is left: no minimum is ever added to it.
 */
export function solveLimits(stepStartedMs: number, nowMs: number, stepSeconds = stepDeadlineSeconds()): { timeoutMs: number; budgetS: number } | null {
  const leftMs = stepSeconds * 1000 - SOLVE_HEADROOM_S * 1000 - (nowMs - stepStartedMs);
  const budgetS = Math.min(SOLVE_BUDGET_S, Math.floor(leftMs / 1000) - SOLVE_MARGIN_S);
  if (budgetS < SOLVE_MIN_BUDGET_S) return null;
  return { timeoutMs: leftMs, budgetS };
}

/** Thrown when a step has too little of its deadline left to read the clip: the step fails (a fresh attempt gets the whole deadline). */
export class SolveTooSlow extends Error {
  constructor(seconds: number) {
    super(`Reading this clip in 3D could not finish in time (the download left ${Math.max(0, Math.round(seconds))} s). Try again.`);
  }
}

/** Reads a drone clip in 3D: `block/run.py` writes solve.json and still.jpg into `outDir`. `stepStartedMs`: when the step began. */
export async function solveClip(videoPath: string, outDir: string, scope: AttemptScope, log: Log = console.log, stepStartedMs = Date.now()): Promise<unknown> {
  const started = Date.now();
  const limits = solveLimits(stepStartedMs, started);
  // Too little left to be worth starting: stop now, inside the step's deadline, rather than run past it. Not stored as
  // the clip's refusal: it is the attempt that ran out (a slow download), so the step fails and can be asked again.
  if (!limits) throw new SolveTooSlow((stepDeadlineSeconds() * 1000 - (started - stepStartedMs)) / 1000);
  const { stdout } = await run(PYTHON, [path.join(BLOCK_DIR, "run.py"), videoPath, outDir], {
    scope,
    timeoutMs: limits.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, FFMPEG_PATH: FFMPEG, PYTHONUNBUFFERED: "1", BLOCK_SOLVE_BUDGET_S: String(limits.budgetS) },
  });
  for (const line of stdout.trim().split("\n").slice(-6)) log(`block-solve: ${line}`);
  log(`block-solve: ${Math.round((Date.now() - started) / 1000)} s`);
  return JSON.parse(await readFile(path.join(outDir, "solve.json"), "utf8"));
}

/**
 * The area label as a picture, `labelImageSize(1)` units scaled to `px` per unit: Playfair from the bundled TTF (the
 * SVG rasteriser cannot read the web fonts the editor uses), white with a soft dark shadow so it reads on grass and dust.
 */
export function renderLabel(text: string, sub: string, px = 120): Promise<{ png: Buffer; width: number; height: number }> {
  // Rendering text starts pango and fontconfig, which costs about as much as the label itself; the same label (a worker
  // drawing the same area twice, the tests) is rendered once. A handful of entries, a few hundred KB.
  const key = JSON.stringify([px, text, sub]);
  let label = labels.get(key);
  if (!label) {
    label = drawLabel(text, sub, px);
    label.catch(() => labels.delete(key));
    if (labels.size >= 16) labels.delete(labels.keys().next().value!);
    labels.set(key, label);
  }
  return label;
}

const labels = new Map<string, Promise<{ png: Buffer; width: number; height: number }>>();

async function drawLabel(text: string, sub: string, px: number): Promise<{ png: Buffer; width: number; height: number }> {
  const size = labelImageSize(px);
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  const line = async (markup: string, pt: number) =>
    sharp({ text: { text: markup, font: `Playfair Display ${pt}`, fontfile: LABEL_FONT_FILE, rgba: true, dpi: 72 } }).png().toBuffer({ resolveWithObject: true });
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const main = await line(`<span foreground="white" weight="500">${escape(text)}</span>`, Math.round(px * 1.45));
  // The same layout as blockSvg's text: the main line's baseline half a cap height under the centre, the sub line (when
  // there is one) under it.
  const mainTop = Math.round(height / 2 + 0.5 * px - main.info.height * 0.78);
  const layers = [{ input: main.data, left: Math.round((width - main.info.width) / 2), top: mainTop }];
  if (sub) {
    const second = await line(`<span foreground="white" alpha="90%">${escape(sub)}</span>`, Math.round(px * 0.62));
    layers.push({ input: second.data, left: Math.round((width - second.info.width) / 2), top: Math.round(height / 2 + 1.4 * px - second.info.height * 0.78) });
  }
  const text$ = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
  // shadow: the text's alpha, blurred, as black at 45%
  const alpha = await sharp(text$).extractChannel(3).blur(px * 0.06).linear(0.45, 0).toBuffer();
  const shadow = await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).joinChannel(alpha).png().toBuffer();
  const png = await sharp(shadow).composite([{ input: text$ }]).png().toBuffer();
  return { png, width, height };
}

/** Reads exactly `bytes` at a time from a stream. */
async function* frames(stream: NodeJS.ReadableStream, bytes: number): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let have = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    pending.push(chunk);
    have += chunk.length;
    while (have >= bytes) {
      const all = Buffer.concat(pending);
      yield all.subarray(0, bytes);
      const rest = all.subarray(bytes);
      pending = rest.length ? [rest] : [];
      have = rest.length;
    }
  }
}

/** The reveal's encoded bitrate ceiling, Mbit/s, and the largest file it may be: 8 s at the ceiling is ~16 MB. */
export const REVEAL_MAX_MBPS = 16;
export const MAX_REVEAL_BYTES = 40 * 1024 * 1024;

/** The ffmpeg to run: a binary, or (for tests) a program and the arguments that come before ffmpeg's own. */
export type FfmpegCommand = { file: string; prefix?: string[] };

/**
 * An ffmpeg owned by the attempt (killed when its scope closes). `done` settles when the process has exited; it is
 * observed here, so a failure is never an unhandled rejection, and callers await it (or settle it) on every path.
 */
function spawnOwned(command: FfmpegCommand, args: string[], scope: AttemptScope, mode: "decode" | "encode"): { child: ChildProcess; done: Promise<void> } {
  const child = spawn(command.file, [...(command.prefix ?? []), ...args], { detached: OWN_PROCESS_GROUP, windowsHide: true, stdio: mode === "decode" ? ["ignore", "pipe", "pipe"] : ["pipe", "ignore", "pipe"] });
  const forget = ownChild(scope, child, `ffmpeg ${mode}`);
  // Killed the moment the attempt is stopped, not when its scope is closed (see `scopeFor`).
  const onAbort = () => killTree(child, "SIGKILL");
  if (scope.signal.aborted) onAbort();
  else scope.signal.addEventListener("abort", onAbort, { once: true });
  let err = "";
  child.stderr?.on("data", (d: Buffer) => {
    err = (err + d.toString()).slice(-2000);
  });
  // A write into an encoder that has died fails with EPIPE; the exit is what is reported, through `done`.
  child.stdin?.on("error", () => undefined);
  child.stdout?.on("error", () => undefined);
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      forget();
      scope.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      forget();
      scope.signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${mode} exited ${code ?? signal}: ${err.trim()}`));
    });
  });
  done.catch(() => undefined);
  return { child, done };
}

/**
 * The output frame (1080 × 1920, RGB) for a window of solve pixels, cut from a decoded source frame (`m` decoded pixels
 * per solve pixel) to sub-pixel precision: a whole-pixel piece with a pixel of margin, then scaled and shifted by the
 * fraction (sharp's affine: input x = (output x − odx) / s). A push-in that moved the crop in whole source pixels would
 * step; this one glides, and the overlay, projected through the same fractional window, stays on the ground.
 */
export async function cropFrame(frame: Buffer, decoded: { width: number; height: number }, win: ViewWindow, m: number): Promise<Buffer> {
  const x = win.x * m;
  const y = win.y * m;
  const s = OUTPUT.width / (win.w * m);
  // The piece holds every real source pixel bicubic reads (2 past the sampling footprint on each side, plus one for
  // rounding), clipped only where the source itself ends; the replicated padding below then only ever stands in for
  // pixels beyond the source (review: a tighter piece padded a copy of its own cut edge into crops inside the frame).
  const halo = 3;
  const left = Math.max(0, Math.floor(x) - halo);
  const top = Math.max(0, Math.floor(y) - halo);
  const width = Math.min(decoded.width, Math.ceil(x + win.w * m) + halo) - left;
  const height = Math.min(decoded.height, Math.ceil(y + win.h * m) + halo) - top;
  // Padded with copies of its edge pixels: at the frame's own edge bicubic reads past the source, where there is
  // nothing (it read black: 150 grey came out 66 at a right/bottom-aligned 2.5x crop).
  const pad = 4;
  const piece = await sharp(frame, { raw: { width: decoded.width, height: decoded.height, channels: 3 } })
    .extract({ left, top, width, height })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: "copy" })
    .raw()
    .toBuffer();
  const scaled = await sharp(piece, { raw: { width: width + 2 * pad, height: height + 2 * pad, channels: 3 } })
    .affine([s, 0, 0, s], { odx: -(x - left + pad) * s, ody: -(y - top + pad) * s, interpolator: sharp.interpolators.bicubic })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp(scaled.data, { raw: { width: scaled.info.width, height: scaled.info.height, channels: 3 } })
    .extract({ left: 0, top: 0, width: Math.min(OUTPUT.width, scaled.info.width), height: Math.min(OUTPUT.height, scaled.info.height) })
    .resize(OUTPUT.width, OUTPUT.height, { fit: "fill" })
    .raw()
    .toBuffer();
}

/**
 * The reveal's decode: from the still's moment for `revealDurationMs` of *source time* (`-t`), resampled to a constant
 * `revealFps` (the `fps` filter), so output frame k is the source at still.t + k / fps whatever the clip's own timing.
 * Raw video carries no timestamps, and a variable-frame-rate phone or drone clip passed through frame for frame put
 * frame k at k / fps against a source that was somewhere else (review round 2). `-frames:v` only caps the count.
 */
export function revealDecodeArgs(solve: BlockSolve, videoPath: string, decoded: { width: number; height: number }): string[] {
  const fps = revealFps(solve);
  const seconds = revealDurationMs(solve) / 1000;
  return [
    "-v", "error", "-ss", String(solve.still.t), "-i", videoPath, "-t", seconds.toFixed(3), "-an",
    "-vf", `fps=${fps},scale=${decoded.width}:${decoded.height}:flags=lanczos`,
    "-frames:v", String(Math.floor(seconds * fps)), "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ];
}

/**
 * Draws the reveal: the clip from the still's moment for `revealDurationMs`, at a constant `revealFps` (see
 * `revealDecodeArgs`), cropped to 9:16 with the push-in, every frame with `drawBlock`'s
 * shapes for its moment on top. Writes an H.264 MP4 (no sound: the reel's music goes under it) to `outPath`.
 *
 * Both ffmpeg processes are supervised from the start: an encoder that dies stops the loop at the next frame, a decoder
 * that ends early is an error (never a short clip saved as a success), and every path waits for both to exit.
 */
export async function renderReveal(input: { videoPath: string; solve: BlockSolve; pin: BlockPin; outPath: string; scope: AttemptScope; onProgress?: (fraction: number) => void; log?: Log; ffmpeg?: FfmpegCommand; maxBytes?: number }): Promise<{ frames: number; durationMs: number; bytes: number }> {
  const { videoPath, solve, pin, outPath, scope } = input;
  const log = input.log ?? console.log;
  const ffmpeg = input.ffmpeg ?? { file: FFMPEG };
  const fps = revealFps(solve);
  const durationMs = revealDurationMs(solve);
  const count = Math.floor((durationMs / 1000) * fps);
  // Decode at the source's own size up to 2160 high: the 9:16 crop of a 4K frame is then about the output's size.
  const decodedHeight = Math.min(solve.source.height, 2160);
  const decoded = { width: Math.round((solve.source.width * decodedHeight) / solve.source.height / 2) * 2, height: decodedHeight };
  const m = decoded.width / solve.intrinsics.width;
  const label = areaText(pin);
  const labelPicture = await renderLabel(label.text, ""); // the area alone: the sub-line was unreadable from a drone
  const labelHref = `data:image/png;base64,${labelPicture.png.toString("base64")}`;
  scope.throwIfStopped();
  const decoder = spawnOwned(ffmpeg, revealDecodeArgs(solve, videoPath, decoded), scope, "decode");
  const encoder = spawnOwned(
    ffmpeg,
    ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${OUTPUT.width}x${OUTPUT.height}`, "-r", String(fps), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
      // Quality first, but bounded: noisy grass at crf 17 can run far past the reels pipeline's rates.
      "-maxrate", `${REVEAL_MAX_MBPS}M`, "-bufsize", `${2 * REVEAL_MAX_MBPS}M`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath],
    scope,
    "encode",
  );
  // Settles (rejects) the moment the encoder exits while frames are still being written to it.
  const encoderGone = encoder.done.then(
    () => Promise.reject(new Error("ffmpeg encode exited before the last frame")),
    (error: unknown) => Promise.reject(error),
  );
  encoderGone.catch(() => undefined);
  const stdin = encoder.child.stdin!;
  const write = (buf: Buffer) => {
    const written = new Promise<void>((resolve, reject) => {
      stdin.write(buf, (error) => (error ? reject(error) : resolve()));
    });
    written.catch(() => undefined);
    return Promise.race([written, encoderGone]);
  };
  let n = 0;
  try {
    for await (const frame of frames(decoder.child.stdout!, decoded.width * decoded.height * 3)) {
      scope.throwIfStopped();
      if (n >= count) break;
      const tMs = (n * 1000) / fps;
      const window = viewAt(solve, pin, tMs);
      const shapes: BlockShape[] = drawBlock(solve, pin, tMs, { window });
      const label = shapes.find((s) => s.kind === "label");
      const svg = blockSvg(shapes, OUTPUT, label?.kind === "label" ? { href: labelHref, ...labelImageSize(label.size) } : undefined);
      const out = await sharp(await cropFrame(frame, decoded, window, m), { raw: { width: OUTPUT.width, height: OUTPUT.height, channels: 3 } })
        .composite([{ input: Buffer.from(svg) }])
        .removeAlpha()
        .raw()
        .toBuffer();
      await write(out);
      n++;
      if (n % 30 === 0) input.onProgress?.(n / count);
    }
  } catch (error) {
    killTree(decoder.child, "SIGKILL");
    killTree(encoder.child, "SIGKILL");
    await Promise.allSettled([decoder.done, encoder.done]);
    throw error;
  }
  stdin.end();
  // Past `count` the decoder is no longer needed; it is stopped and its exit (a kill) is not an error.
  const stoppedDecoder = n >= count && decoder.child.exitCode === null;
  if (stoppedDecoder) killTree(decoder.child, "SIGKILL");
  const [decoding, encoding] = await Promise.allSettled([decoder.done, encoder.done]);
  if (encoding.status === "rejected") throw encoding.reason;
  // One frame short is rounding at the clip's end; more is footage that is not there.
  if (n < count - 1) {
    if (decoding.status === "rejected" && !stoppedDecoder) throw decoding.reason;
    throw new Error(`The drone clip ended early: ${n} of ${count} frames.`);
  }
  // Checked before anything reads it whole (the upload buffers it): an encode past the cap is a clear failure.
  const { size: bytes } = await stat(outPath);
  const maxBytes = input.maxBytes ?? MAX_REVEAL_BYTES;
  if (bytes > maxBytes) throw new Error(`The reveal came out at ${(bytes / 1048576).toFixed(1)} MB, over the ${(maxBytes / 1048576).toFixed(0)} MB a reveal may be.`);
  log(`block-reveal: ${n} frames at ${fps} fps, ${bytes} bytes, ${pin.build}, ${label.text}`);
  return { frames: n, durationMs: Math.round((n * 1000) / fps), bytes };
}

async function download(key: string, to: string, scope: AttemptScope): Promise<void> {
  const object = await s3.send(new GetObjectCommand({ Bucket: getConfig().s3Bucket, Key: key }), { abortSignal: scope.signal });
  if (!object.Body) throw new Error("The clip's file is missing from storage.");
  await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(to));
}

/**
 * Puts a file the step made (the reveal, its thumbnail: tens of MB at most). It is read whole first, so no read stream
 * is left opening the file after a failure or an abort, and a file that has gone is a plain rejected promise here.
 */
export async function upload(key: string, file: string, contentType: string, scope: AttemptScope): Promise<number> {
  const body = await readFile(file);
  scope.throwIfStopped();
  scope.throwIfStopped();
  await s3.send(new PutObjectCommand({ Bucket: getConfig().s3Bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: contentType }), { abortSignal: scope.signal });
  return body.byteLength;
}

async function findClip(workspaceId: string, assetId: string) {
  // The workspace's own clip, or a shared library clip (the starter drone footage).
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, kind: "VIDEO", OR: [{ workspaceId }, { shared: true }] }, select: { id: true, objectKey: true, fileName: true } });
  if (!asset) throw new Error("That clip is not in this workspace.");
  return asset;
}

export async function runBlockSolveStep(step: { payload: unknown; user: { workspaceId: string } }, scope?: AttemptScope): Promise<BlockSolveStepResult> {
  const stepStarted = Date.now();
  const { assetId } = blockSolvePayloadSchema.parse(step.payload);
  const asset = await findClip(step.user.workspaceId, assetId);
  const own = scope ? null : createAttemptScope();
  const attempt = scope ?? own!;
  try {
    const dir = await attempt.tempDir("reelwalk-block-");
    const video = path.join(dir, `clip${path.extname(asset.objectKey) || ".mp4"}`);
    await download(asset.objectKey, video, attempt);
    const out = path.join(dir, "out");
    const result = parseBlockSolve(await solveClip(video, out, attempt, console.log, stepStarted));
    const body = Buffer.from(await readFile(path.join(out, "solve.json")));
    if (result.ok) await upload(blockStillKeyFor(asset.id), path.join(out, "still.jpg"), "image/jpeg", attempt);
    // Written last: its presence is what tells the web app the still is there too.
    attempt.throwIfStopped();
    await s3.send(new PutObjectCommand({ Bucket: getConfig().s3Bucket, Key: blockSolveKeyFor(asset.id), Body: body, ContentLength: body.byteLength, ContentType: "application/json" }), { abortSignal: attempt.signal });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const { stats } = result.solve;
    return { ok: true, frames: stats.frames, registered: stats.registered, medianReprojectionPx: stats.medianReprojectionPx };
  } finally {
    await own?.close();
  }
}

export async function runBlockRevealStep(step: { id: string; payload: unknown; user: { id: string; workspaceId: string } }, scope?: AttemptScope): Promise<BlockRevealStepResult> {
  const { assetId, pin } = blockRevealPayloadSchema.parse(step.payload);
  const asset = await findClip(step.user.workspaceId, assetId);
  const own = scope ? null : createAttemptScope();
  const attempt = scope ?? own!;
  try {
    const stored = await s3.send(new GetObjectCommand({ Bucket: getConfig().s3Bucket, Key: blockSolveKeyFor(asset.id) }), { abortSignal: attempt.signal });
    const parsed = parseBlockSolve(JSON.parse((await stored.Body?.transformToString()) ?? "null"));
    if (!parsed.ok) throw new Error(parsed.message);
    const dir = await attempt.tempDir("reelwalk-reveal-");
    const video = path.join(dir, `clip${path.extname(asset.objectKey) || ".mp4"}`);
    await download(asset.objectKey, video, attempt);
    const outPath = path.join(dir, "reveal.mp4");
    const { durationMs } = await renderReveal({ videoPath: video, solve: parsed.solve, pin, outPath, scope: attempt });
    const thumbPath = path.join(dir, "reveal.jpg");
    // The library's thumbnail: the reveal's last frame, the massing standing, 240 px high.
    await run(FFMPEG, ["-v", "error", "-y", "-sseof", "-0.5", "-i", outPath, "-frames:v", "1", "-vf", "scale=-2:240", "-q:v", "4", thumbPath], { scope: attempt });
    const id = `block-${step.id}`;
    const objectKey = `workspaces/${step.user.workspaceId}/blocks/${step.id}.mp4`;
    const thumbKey = `workspaces/${step.user.workspaceId}/blocks/${step.id}.jpg`;
    const sizeBytes = await upload(objectKey, outPath, "video/mp4", attempt);
    await upload(thumbKey, thumbPath, "image/jpeg", attempt);
    const { text } = areaText(pin);
    const timeline = emptyTimeline();
    timeline.clips.push(clipSchema.parse({ id: `clip-${id}`, assetId: id, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: durationMs }));
    // House style: one quiet serif title from frame 0, above the caption zone and off the centre.
    timeline.texts.push(textSchema.parse({ id: `title-${id}`, text: "Drawn to scale.", startMs: 0, endMs: durationMs, x: 0.5, y: 0.16, style: "elegant", byApp: true }));
    attempt.throwIfStopped();
    const reelId = await prisma.$transaction(async (tx) => {
      // A stop that lands while the transaction waits for a connection writes nothing.
      attempt.throwIfStopped();
      await tx.mediaAsset.upsert({
        where: { objectKey },
        update: {},
        create: {
          id, workspaceId: step.user.workspaceId, kind: "VIDEO", objectKey, thumbKey, previewKey: objectKey, contentType: "video/mp4",
          fileName: `Walk the block — ${BUILDS[pin.build].label}, ${text}.mp4`, sizeBytes: BigInt(sizeBytes), durationMs,
          width: OUTPUT.width, height: OUTPUT.height,
          attribution: `Drawn to scale on ${asset.fileName} (ReelWalk Walk the block)`,
        },
      });
      const reel = await tx.reel.upsert({
        where: { id: `walk-${step.id}` },
        update: {},
        create: { id: `walk-${step.id}`, workspaceId: step.user.workspaceId, title: `${BUILDS[pin.build].label} · ${text}`, timeline },
        select: { id: true },
      });
      return reel.id;
    });
    return { assetId: id, reelId };
  } finally {
    await own?.close();
  }
}
