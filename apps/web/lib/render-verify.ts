import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CHECK_SERIES,
  checkDecodeArgs,
  checksKeyFor,
  judgeTimesMs,
  letterSpacingEm,
  parseReelExportPayload,
  postBlockReason,
  REEL_FORMAT,
  renderChecks,
  seriesFromGreyFrames,
  withAudioProblems,
  type AudioProblem,
  type RenderChecks,
  type TextOverlay,
  type Timeline,
  type TitleFont,
} from "@reelwalk/core";
// Import the pure look helpers, not the reel barrel: that pulls Remotion
// components (hooks) into this server-only module and breaks the RSC build.
import { textTreatmentCss } from "@reelwalk/render/reel/look";

/**
 * Verification of a rendered reel over HTTP (ADR 0071): the frames and the
 * facts an agent used to get from ffmpeg strips and offline scans, served by
 * the app from the export itself.
 *
 *   frames   JPEGs at reel times (one, several, or a contact sheet)
 *   checks   the RenderChecks the worker stored beside the export, or
 *            computed here once and stored, when ffmpeg is on this machine
 *   gate     whether Post and Schedule are blocked, and why
 *
 * The export is downloaded once to a cache under the OS temp dir, keyed by
 * its object key (immutable: a retry renders to a new key), and every frame
 * cut from it is kept there too. The decode is ffmpeg's: `FFMPEG_PATH`, or
 * `ffmpeg` on PATH; without one the frames route answers 503 and the checks
 * route serves only what the worker stored.
 */

const exec = promisify(execFile);
const FRAME_MS = 1000 / REEL_FORMAT.fps;

export const VERIFY = {
  /** Most moments one frames request may ask for. */
  maxTimes: 24,
  /** Frame width in px: the default, and the largest allowed. */
  defaultWidth: 270,
  maxWidth: 1080,
  /** JPEG quality for ffmpeg's mjpeg (2 best … 31 worst). */
  jpegQ: 4,
  /** A cached export older than this is removed on the next download. */
  cacheTtlMs: 6 * 3600_000,
  /** The raw grey decode of a long reel: 72×128 × 30 fps is 276 KB a second. */
  decodeMaxBytes: 96 * 1024 * 1024,
  decodeTimeoutMs: 120_000,
  frameTimeoutMs: 30_000,
} as const;

// ── Pure helpers (tested) ──────────────────────────────────────

/**
 * `t=0,0.5,1.5` (seconds, or `ms` suffixed) to reel ms on the frame grid,
 * each kept once in the order given, clamped into the reel, at most `maxTimes`.
 * Negative values count back from the end (`-0.5` is half a second before
 * it); `end` is the last frame.
 */
export function parseTimes(param: string | null | undefined, durationMs: number, maxTimes: number = VERIFY.maxTimes): number[] {
  const last = Math.max(0, Math.floor((durationMs - 1) / FRAME_MS) * FRAME_MS);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of (param ?? "").split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    const inMs = token.endsWith("ms");
    const value = token === "end" || token === "last" ? last : Number(inMs ? token.slice(0, -2) : token);
    if (!Number.isFinite(value)) continue;
    let ms = inMs || token === "end" || token === "last" ? value : value * 1000;
    if (ms < 0) ms = last + ms;
    const onGrid = Math.round(Math.min(last, Math.max(0, ms)) / FRAME_MS) * FRAME_MS;
    const key = Math.round(onGrid);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= maxTimes) break;
  }
  return out;
}

/** A requested width, clamped to an even number between 54 and the maximum. */
export function parseWidth(param: string | null | undefined): number {
  const value = Number(param);
  const width = Number.isFinite(value) && value > 0 ? value : VERIFY.defaultWidth;
  return Math.max(54, Math.min(VERIFY.maxWidth, Math.round(width / 2) * 2));
}

/**
 * ffmpeg arguments for one JPEG at `ms`: an input seek, then the first decoded frame. The seek lands
 * 10 ms early: frames sit on a 33 ms grid, so the first frame at or after it is the one asked for,
 * and the last frame of the file is still found (seeking to its own time rounds past it).
 */
export function frameArgs(input: string, ms: number, width: number): string[] {
  const seconds = (Math.max(0, ms - 10) / 1000).toFixed(3);
  return ["-v", "error", "-nostdin", "-ss", seconds, "-i", input, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", String(VERIFY.jpegQ), "-f", "image2pipe", "-vcodec", "mjpeg", "-"];
}


/** Where a render's files live in the cache: a short hash of its key, never the key itself. */
export function cacheDirFor(root: string, objectKey: string): string {
  return path.join(root, createHash("sha1").update(objectKey).digest("hex").slice(0, 16));
}

export const frameFileName = (ms: number, width: number) => `f-${Math.round(ms)}-${width}.jpg`;

/** The stored checks, if they are this module's shape; anything else is treated as missing. */
export function parseStoredChecks(value: unknown): RenderChecks | null {
  if (!value || typeof value !== "object") return null;
  const checks = value as Partial<RenderChecks>;
  if (checks.version !== 1 || !Array.isArray(checks.checks) || typeof checks.durationMs !== "number" || !checks.facts) return null;
  return checks as RenderChecks;
}

export type Gate = { blocked: boolean; reason: string | null; reasons: string[]; checked: boolean };

/** What the Post and Schedule buttons do with a result: nothing special when there are no checks. */
export function gateFor(checks: RenderChecks | null): Gate {
  if (!checks) return { blocked: false, reason: null, reasons: [], checked: false };
  return { blocked: checks.blocked, reason: postBlockReason(checks), reasons: checks.blockReasons, checked: true };
}

/** The audio trace's problems, whatever shape W3-A's route settles on, as checks; nothing when it is not a list. */
export function audioProblemsFrom(value: unknown): AudioProblem[] | null {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? ((value as { problems?: unknown }).problems ?? (value as { issues?: unknown }).issues) : null;
  if (!Array.isArray(list)) return null;
  const out: AudioProblem[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const title = typeof p.title === "string" ? p.title : typeof p.summary === "string" ? p.summary : null;
    if (!title) continue;
    out.push({
      id: String(p.id ?? title).slice(0, 80),
      level: p.level === "block" || p.severity === "high" ? "block" : "warn",
      title,
      detail: typeof p.detail === "string" ? p.detail : typeof p.reason === "string" ? p.reason : title,
      ...(typeof p.atMs === "number" ? { atMs: p.atMs } : {}),
    });
  }
  return out;
}

/** A title's font as the renderer styles it (the editor's critic uses the same mapping). */
export function titleFontOf(text: TextOverlay): TitleFont {
  const css = textTreatmentCss(text);
  return { fontFamily: String(css.fontFamily ?? ""), fontWeight: css.fontWeight, fontSize: Number(css.fontSize) || 64, letterSpacing: text.tracking ?? letterSpacingEm(css.letterSpacing), fontStretch: css.fontStretch ? String(css.fontStretch) : undefined };
}

// ── ffmpeg ─────────────────────────────────────────────────────

let ffmpegPath: string | null | undefined;

/** The ffmpeg to use here: `FFMPEG_PATH`, or `ffmpeg` on PATH; null (and the routes say so) when neither runs. */
export function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const configured = process.env.FFMPEG_PATH;
  if (configured) {
    try { accessSync(configured, constants.X_OK); ffmpegPath = configured; return configured; } catch { /* fall through */ }
  }
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try { accessSync(candidate, constants.X_OK); ffmpegPath = candidate; return candidate; } catch { /* next */ }
  }
  ffmpegPath = null;
  return null;
}

/** For tests and scripts: use this binary. */
export function setFfmpeg(binary: string | null | undefined): void {
  ffmpegPath = binary;
}

export const ffmpegAvailable = () => findFfmpeg() !== null;

async function ffmpeg(args: string[], options: { maxBuffer: number; timeoutMs: number }): Promise<Buffer> {
  const binary = findFfmpeg();
  if (!binary) throw new Error("ffmpeg is not available on this server");
  const { stdout } = await exec(binary, args, { encoding: "buffer", maxBuffer: options.maxBuffer, timeout: options.timeoutMs, windowsHide: true });
  return stdout;
}

// ── The cache ──────────────────────────────────────────────────

export type VerifyDeps = {
  cacheRoot: string;
  download(objectKey: string, destination: string): Promise<void>;
  readJson(objectKey: string): Promise<unknown | null>;
  putJson(objectKey: string, value: unknown): Promise<void>;
};

const defaultDeps = (): VerifyDeps => ({
  cacheRoot: path.join(os.tmpdir(), "reelwalk-verify"),
  async download(objectKey, destination) {
    const { downloadObject } = await import("./storage");
    await downloadObject(objectKey, destination);
  },
  async readJson(objectKey) {
    const { readObject } = await import("./storage");
    const object = await readObject(objectKey, 2 * 1024 * 1024);
    if (!object) return null;
    try { return JSON.parse(object.bytes.toString("utf8")) as unknown; } catch { return null; }
  },
  async putJson(objectKey, value) {
    const { putObject } = await import("./storage");
    await putObject(objectKey, Buffer.from(JSON.stringify(value)), "application/json");
  },
});

const downloads = new Map<string, Promise<string>>();

/** The export on local disk, downloaded once per process and kept for `cacheTtlMs`. */
export async function localRender(objectKey: string, deps: VerifyDeps = defaultDeps()): Promise<string> {
  const pending = downloads.get(objectKey);
  if (pending) return pending;
  const job = (async () => {
    const dir = cacheDirFor(deps.cacheRoot, objectKey);
    const file = path.join(dir, "render.mp4");
    try {
      if ((await stat(file)).size > 0) return file;
    } catch { /* not cached */ }
    await mkdir(dir, { recursive: true });
    await sweepCache(deps.cacheRoot).catch(() => undefined);
    const partial = `${file}.part`;
    await deps.download(objectKey, partial);
    await rename(partial, file);
    return file;
  })();
  downloads.set(objectKey, job);
  try {
    return await job;
  } finally {
    downloads.delete(objectKey);
  }
}

/** Renders not touched for the TTL are removed (disk is small on the web instance). */
async function sweepCache(root: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(root).catch((): string[] => [])) {
    const dir = path.join(root, name);
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory() && now - info.mtimeMs > VERIFY.cacheTtlMs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── Frames ─────────────────────────────────────────────────────

/** A JPEG of the render at `ms`, `width` px across, from the cache or cut now. */
export async function frameAt(objectKey: string, ms: number, width: number, deps: VerifyDeps = defaultDeps()): Promise<Buffer> {
  const dir = cacheDirFor(deps.cacheRoot, objectKey);
  const file = path.join(dir, frameFileName(ms, width));
  try {
    return await readFile(file);
  } catch { /* cut it */ }
  const input = await localRender(objectKey, deps);
  const jpeg = await ffmpeg(frameArgs(input, ms, width), { maxBuffer: 16 * 1024 * 1024, timeoutMs: VERIFY.frameTimeoutMs });
  if (!jpeg.length) throw new Error(`No frame at ${ms} ms`);
  await writeFile(file, jpeg).catch(() => undefined);
  return jpeg;
}

/** The frames at `times`, cut two at a time. */
export async function framesAt(objectKey: string, times: readonly number[], width: number, deps: VerifyDeps = defaultDeps()): Promise<Buffer[]> {
  const out: Buffer[] = new Array(times.length);
  let next = 0;
  const worker = async () => {
    while (next < times.length) {
      const index = next++;
      out[index] = await frameAt(objectKey, times[index], width, deps);
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}

/** One JPEG with the frames side by side, in the order given, each `width` px across. */
export async function contactSheet(frames: readonly Buffer[], width: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const height = Math.round((width * REEL_FORMAT.height) / REEL_FORMAT.width / 2) * 2;
  const gap = 4;
  const sheet = sharp({ create: { width: frames.length * (width + gap) - gap, height, channels: 3, background: { r: 16, g: 16, b: 16 } } });
  const tiles = await Promise.all(frames.map(async (frame, index) => ({ input: await sharp(frame).resize(width, height, { fit: "cover" }).toBuffer(), left: index * (width + gap), top: 0 })));
  return sheet.composite(tiles).jpeg({ quality: 82 }).toBuffer();
}

// ── Checks ─────────────────────────────────────────────────────

export type ChecksSource = "stored" | "computed" | "none";

export type ChecksResult = { checks: RenderChecks | null; source: ChecksSource; reason?: string };

/** The timeline an export was rendered from, or null for an export without a parseable payload. */
export function exportTimeline(payload: unknown): Timeline | null {
  try {
    return parseReelExportPayload(payload).timeline;
  } catch {
    return null;
  }
}

/** The render's checks computed from its file: the decode, then the pure checks against the export's timeline. */
export async function computeChecks(objectKey: string, timeline: Timeline | null, deps: VerifyDeps = defaultDeps()): Promise<RenderChecks> {
  const input = await localRender(objectKey, deps);
  const grey = await ffmpeg(checkDecodeArgs(input), { maxBuffer: VERIFY.decodeMaxBytes, timeoutMs: VERIFY.decodeTimeoutMs });
  const series = seriesFromGreyFrames(grey);
  return renderChecks({ timeline, series, titleFont: titleFontOf, durationMs: series.length ? series[series.length - 1].ms + 1000 / CHECK_SERIES.fps : 0 });
}

/**
 * The checks for an export: what the worker stored beside it; else, with
 * ffmpeg here, computed once and stored for next time; else none, with the
 * reason. `fresh` recomputes (after a deploy that changed the checks).
 */
export async function ensureChecks(job: { output: { objectKey: string } | null; payload: unknown }, options: { fresh?: boolean; compute?: boolean; deps?: VerifyDeps } = {}): Promise<ChecksResult> {
  const deps = options.deps ?? defaultDeps();
  if (!job.output) return { checks: null, source: "none", reason: "This export has not finished." };
  const key = checksKeyFor(job.output.objectKey);
  if (!options.fresh) {
    const stored = parseStoredChecks(await deps.readJson(key).catch(() => null));
    if (stored) return { checks: stored, source: "stored" };
  }
  if (options.compute === false) return { checks: null, source: "none", reason: "The checks have not run for this export yet." };
  if (!ffmpegAvailable()) return { checks: null, source: "none", reason: "No checks are stored for this export and ffmpeg is not available on this server." };
  const checks = await computeChecks(job.output.objectKey, exportTimeline(job.payload), deps);
  await deps.putJson(key, checks).catch((error: unknown) => console.warn(`[verify] checks not stored for ${key}: ${error instanceof Error ? error.message : error}`));
  return { checks, source: "computed" };
}

/** Stored checks with the sound's problems folded in when the audio trace answered. */
export const withAudio = (checks: RenderChecks, problems: AudioProblem[] | null) => (problems ? withAudioProblems(checks, problems) : checks);

/** Whether Post and Schedule are blocked for an export. Never throws: a verification failure is not a reason to lose a post. */
export async function postGate(job: { id: string; output: { objectKey: string } | null; payload: unknown }): Promise<Gate> {
  try {
    const { checks } = await ensureChecks(job);
    return gateFor(checks);
  } catch (error) {
    console.warn(`[verify] gate skipped for ${job.id}: ${error instanceof Error ? error.message : error}`);
    return { blocked: false, reason: null, reasons: [], checked: false };
  }
}

/** The line the logs carry when a blocked export is posted anyway. */
export function postAnywayLine(input: { jobId: string; userId: string; action: "post" | "schedule"; reasons: readonly string[] }): string {
  return JSON.stringify({ event: "post-anyway", action: input.action, jobId: input.jobId, userId: input.userId, reasons: input.reasons });
}

/** The Judge view's moments for a reel of this length, as one `t=` value. */
export const judgeTimesParam = (durationMs: number) => {
  const { opening, ending } = judgeTimesMs(durationMs);
  return [...opening, ...ending].map((ms) => `${ms}ms`).join(",");
};
