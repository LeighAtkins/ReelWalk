import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition, type CancelSignal, type OpenGlRenderer as GlRenderer } from "@remotion/renderer";
import { clipDurationMs, clipStartsMs, isInstagramMusic, REEL_FORMAT, type Timeline } from "@reelwalk/core";
import { mkdtemp, rm } from "node:fs/promises";
import { REEL_COMPOSITION_ID, type ReelAsset } from "./reel/types";
import { renderConcurrency } from "./concurrency";
import { RENDER_PAGE_PORT, serveBundle } from "./bundle-server";

const RENDER_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDER_PKG_DIR = path.resolve(RENDER_SRC_DIR, "..");
const RENDER_PUBLIC_DIR = path.join(RENDER_PKG_DIR, "public");
const DEFAULT_BUNDLE_DIR = path.join(RENDER_PKG_DIR, "dist", "remotion-bundle");
const BUNDLE_STAMP_FILE = ".reelwalk-bundle-stamp.json";

let bundled: Promise<string> | null = null;

/** Preflight stills drawn at once when the caller does not say (capped at the cores). */
const PREFLIGHT_CONCURRENCY = 3;

function hashTree(dir: string, hash: ReturnType<typeof createHash>, prefix: string): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      hashTree(full, hash, rel);
    } else if (entry.isFile()) {
      hash.update(rel);
      hash.update("\0");
      hash.update(readFileSync(full));
      hash.update("\0");
    }
  }
}

/** Deterministic content hash of renderer sources, bundled public assets, and core sources so a pre-built bundle is reused only when exact. */
export function computeRenderBundleStamp(): string {
  const hash = createHash("sha256");
  const corePkgDir = path.resolve(RENDER_PKG_DIR, "..", "core");
  hashTree(RENDER_SRC_DIR, hash, "render/src");
  hashTree(RENDER_PUBLIC_DIR, hash, "render/public");
  hashTree(path.join(corePkgDir, "src"), hash, "core/src");
  for (const manifest of [path.join(RENDER_PKG_DIR, "package.json"), path.join(corePkgDir, "package.json")]) {
    if (existsSync(manifest)) {
      hash.update(path.basename(path.dirname(manifest)));
      hash.update(readFileSync(manifest));
    }
  }
  return hash.digest("hex");
}

export function readValidPrebuiltBundle(dir: string, expectedStamp: string): string | null {
  const indexHtml = path.join(dir, "index.html");
  const stampPath = path.join(dir, BUNDLE_STAMP_FILE);
  if (!existsSync(indexHtml) || !existsSync(stampPath)) return null;
  try {
    const saved = JSON.parse(readFileSync(stampPath, "utf8")) as { stamp?: string };
    return saved.stamp === expectedStamp ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Builds the Remotion webpack bundle into a persistent directory (or os.tmpdir fallback)
 * and stamps it with the source content hash so fresh worker processes reuse it without re-bundling.
 */
export async function buildRenderBundle(outDir = process.env.REMOTION_BUNDLE_DIR || DEFAULT_BUNDLE_DIR): Promise<string> {
  const entryPoint = path.join(RENDER_SRC_DIR, "index.ts");
  const stamp = computeRenderBundleStamp();
  const webpackCacheDir = path.join(os.tmpdir(), "reelwalk-webpack-cache");
  let writableOutDir: string | undefined;
  try {
    mkdirSync(outDir, { recursive: true });
    accessSync(outDir, constants.W_OK);
    writableOutDir = outDir;
  } catch {
    writableOutDir = undefined;
  }
  // The bundled sound set (ADR 0066) is served from the package's public dir, so `staticFile("sfx/…")` resolves in the worker.
  const dir = await bundle({
    entryPoint,
    publicDir: RENDER_PUBLIC_DIR,
    ...(writableOutDir ? { outDir: writableOutDir } : {}),
    webpackOverride: (config) => ({
      ...config,
      cache: {
        type: "filesystem",
        cacheDirectory: webpackCacheDir,
      },
    }),
  });
  if (writableOutDir && existsSync(path.join(dir, "index.html"))) {
    try {
      writeFileSync(path.join(dir, BUNDLE_STAMP_FILE), JSON.stringify({ stamp, builtAt: new Date().toISOString() }));
    } catch {
      // Read-only filesystem: bundle still works for this process lifetime.
    }
  }
  return dir;
}

/**
 * Chrome's GL backend for the render (`REELWALK_RENDER_GL`, a Remotion `gl` value such as "swangle"), unset by default so
 * nothing changes. A zoom blur (ADR 0074) is displacement-map filters, which software GL runs several times slower than
 * the Gaussian of the other transitions; on the machine measured, "swangle" took its export from 1.84× to 1.24× the
 * plain-cut one. On Linux it is the other way round for a reel without one: the smoke reel took 121 s with "swangle"
 * against 60 s with the default (4 cores, 3 tabs, 2026-10-31), so it stays a switch and not the default.
 */
function chromiumOptions(): { gl: GlRenderer } | undefined {
  const gl = process.env.REELWALK_RENDER_GL?.trim();
  return gl ? { gl: gl as GlRenderer } : undefined;
}

/**
 * One browser across `selectComposition` and rendering (`renderMedia` or a run of stills).
 * Without one, each step launches and closes its own Chrome and reloads the bundle, fonts and
 * matte models.
 */
async function withBrowser<T>(use: (browser: Awaited<ReturnType<typeof openBrowser>>) => Promise<T>): Promise<T> {
  const browser = await openBrowser("chrome", { chromiumOptions: chromiumOptions() ?? {} });
  try {
    return await use(browser);
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
  }
}

/**
 * Webpack-bundling the compositions takes several seconds. Reel assets are
 * passed as URLs rather than copied into the bundle, so one pre-built or
 * in-process bundle serves every render this process does. It is served once,
 * on RENDER_PAGE_PORT (ADR 0107): every page has the origin the media bucket's
 * CORS allows, however many stills draw at once. If that port is taken,
 * Remotion serves the bundle itself as before, and a person matte may then fail
 * its CORS check.
 */
function getServeUrl(): Promise<string> {
  if (!bundled) {
    const outDir = process.env.REMOTION_BUNDLE_DIR || DEFAULT_BUNDLE_DIR;
    const prebuilt = readValidPrebuiltBundle(outDir, computeRenderBundleStamp());
    const bundleDir = prebuilt ? Promise.resolve(prebuilt) : buildRenderBundle(outDir);
    bundled = bundleDir
      .then((dir) =>
        serveBundle(dir).then(
          ({ url }) => url,
          (error) => {
            console.warn(`render page: port ${RENDER_PAGE_PORT} is not free (${error instanceof Error ? error.message : error}); Remotion serves the bundle on its own ports, where person mattes can fail CORS`);
            return dir;
          },
        ),
      )
      .catch((error) => {
        bundled = null;
        throw error;
      });
  }
  return bundled;
}

/**
 * Remotion's cancel signal driven by an AbortSignal (ADR 0050): aborting
 * cancels the render, which stops its compositor and stitcher and closes the
 * browser it opened. `done` unhooks the listener once the call settles.
 */
export function remotionCancel(signal: AbortSignal | undefined): { cancelSignal: CancelSignal | undefined; done: () => void } {
  if (!signal) return { cancelSignal: undefined, done: () => {} };
  const { cancelSignal, cancel } = makeCancelSignal();
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  return { cancelSignal, done: () => signal.removeEventListener("abort", cancel) };
}

export async function renderReel(
  input: {
    timeline: Timeline;
    assets: Record<string, ReelAsset>;
    output: string;
    concurrency?: number;
    /** Frame width, 720 or 1080 (the composition is laid out at 1080 and scaled). */
    width?: number;
    watermark?: boolean;
    /** Aborting cancels the render and closes its browser; the promise then rejects. */
    signal?: AbortSignal;
  },
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const serveUrl = await getServeUrl();
  input.signal?.throwIfAborted();
  // Last line of defence (ADR 0019): an Instagram sound is never baked into an export.
  const timeline = isInstagramMusic(input.timeline.music) ? { ...input.timeline, music: null } : input.timeline;
  const inputProps = { timeline, assets: input.assets, watermark: input.watermark ?? false };
  const outputLocation = path.resolve(input.output);

  await withBrowser(async (puppeteerInstance) => {
    input.signal?.throwIfAborted();
    const composition = await selectComposition({ serveUrl, id: REEL_COMPOSITION_ID, inputProps, puppeteerInstance });

    input.signal?.throwIfAborted();
    const cancel = remotionCancel(input.signal);
    // Instagram re-encodes every upload, so start from a high-quality source:
    // H.264, yuv420p, AAC, 30 fps, 1080x1920. Remotion adds +faststart for H.264.
    await renderMedia({
      chromiumOptions: chromiumOptions(),
      composition,
      puppeteerInstance,
      serveUrl,
      codec: "h264",
      crf: 18,
      audioBitrate: "192k",
      pixelFormat: "yuv420p",
      // Limited-range BT.709, the standard for web video. Without it the output
      // is full-range (yuvj420p), which some players show with shifted colours.
      colorSpace: "bt709",
      // Free-plan exports come out at 720×1280: same layout, scaled down.
      scale: (input.width ?? 1080) / 1080,
      inputProps,
      outputLocation,
      concurrency: renderConcurrency(input.concurrency, os.availableParallelism()),
      // Inside a container Remotion sizes these caches from the host's memory,
      // not the cgroup limit, and the compositor gets killed. Fixed, modest
      // caches instead; 1080p sources do not need more.
      offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024,
      mediaCacheSizeInBytes: 512 * 1024 * 1024,
      onProgress: ({ progress }) => onProgress?.(progress),
      cancelSignal: cancel.cancelSignal,
    }).finally(cancel.done);
  });
  return outputLocation;
}

/**
 * The frames a render is most likely to die on: the first and last frame of
 * every shot (a title or matte that mounts, a pin that overlaps the next cut).
 * Each is tagged with the shot it belongs to so a failure names the shot.
 */
export type CheckpointEdge = "first" | "middle" | "last";

/** The frames preflight draws: the first, middle and last frame of every shot (ADR 0042; the middle since the review of 2026-10-20, where motion, pins and mattes are mid-way). */
export function reelCheckpoints(timeline: Timeline, fps: number = REEL_FORMAT.fps): { frame: number; shot: number; edge: CheckpointEdge; clipId: string }[] {
  const starts = clipStartsMs(timeline);
  const out: { frame: number; shot: number; edge: CheckpointEdge; clipId: string }[] = [];
  timeline.clips.forEach((clip, i) => {
    const first = Math.round((starts[i] * fps) / 1000);
    const last = Math.max(first, Math.round(((starts[i] + clipDurationMs(clip)) * fps) / 1000) - 1);
    const middle = Math.round((first + last) / 2);
    out.push({ frame: first, shot: i + 1, edge: "first", clipId: clip.id });
    if (middle !== first && middle !== last) out.push({ frame: middle, shot: i + 1, edge: "middle", clipId: clip.id });
    if (last !== first) out.push({ frame: last, shot: i + 1, edge: "last", clipId: clip.id });
  });
  return out;
}

export class PreflightError extends Error {
  constructor(public readonly shot: number, public readonly edge: CheckpointEdge, public readonly frame: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    super(`Shot ${shot} could not be drawn at its ${edge} frame (frame ${frame}): ${reason}`);
    this.name = "PreflightError";
  }
}

/**
 * Before a full render, draw the first, middle and last frame of every shot as stills (ADR 0042). A frame that errors or
 * hangs fails here in seconds, naming the shot, instead of minutes into the render. Up to `concurrency` stills draw at
 * once in one shared browser (capped at the cores, as the render is): each still is mostly waiting on a video seek and the
 * matte, so a 4-vCPU worker draws three in about the time of one. When several fail, the earliest checkpoint is the one
 * reported, as it was when they drew one at a time. Returns the still paths when `keepIn` is given (the smoke test lays
 * them out); otherwise they are removed.
 */
export async function preflightReel(
  input: { timeline: Timeline; assets: Record<string, ReelAsset>; keepIn?: string; timeoutMs?: number; width?: number; signal?: AbortSignal; concurrency?: number },
  onProgress?: (done: number, total: number) => void,
): Promise<{ frame: number; shot: number; edge: CheckpointEdge; path: string }[]> {
  const serveUrl = await getServeUrl();
  input.signal?.throwIfAborted();
  const timeline = isInstagramMusic(input.timeline.music) ? { ...input.timeline, music: null } : input.timeline;
  const inputProps = { timeline, assets: input.assets, watermark: false };
  const dir = input.keepIn ?? (await mkdtemp(path.join(os.tmpdir(), "reelwalk-preflight-")));
  try {
    return await withBrowser(async (puppeteerInstance) => {
      const composition = await selectComposition({ serveUrl, id: REEL_COMPOSITION_ID, inputProps, puppeteerInstance });
      const points = reelCheckpoints(timeline, composition.fps).filter((p) => p.frame < composition.durationInFrames);
      const made: ({ frame: number; shot: number; edge: CheckpointEdge; path: string } | undefined)[] = new Array(points.length);
      const failures: { index: number; error: unknown }[] = [];
      let next = 0;
      let done = 0;
      const lane = async () => {
        while (next < points.length && failures.length === 0) {
          const index = next++;
          const point = points[index];
          const output = path.join(dir, `shot-${String(point.shot).padStart(2, "0")}-${point.edge}.jpg`);
          input.signal?.throwIfAborted();
          const cancel = remotionCancel(input.signal);
          try {
            await renderStill({
              chromiumOptions: chromiumOptions(),
              composition, serveUrl, inputProps, output, frame: point.frame, imageFormat: "jpeg", jpegQuality: 80, puppeteerInstance,
              scale: (input.width ?? 540) / 1080,
              timeoutInMilliseconds: input.timeoutMs ?? 30_000,
              offthreadVideoCacheSizeInBytes: 256 * 1024 * 1024,
              cancelSignal: cancel.cancelSignal,
            });
          } catch (error) {
            // A cancelled preflight is not a broken shot: report the cancellation as it is.
            if (input.signal?.aborted) throw input.signal.reason;
            failures.push({ index, error });
            return;
          } finally {
            cancel.done();
          }
          made[index] = { ...point, path: output };
          onProgress?.(++done, points.length);
        }
      };
      const lanes = Math.min(points.length, renderConcurrency(input.concurrency ?? PREFLIGHT_CONCURRENCY, os.availableParallelism()));
      await Promise.all(Array.from({ length: lanes }, lane));
      if (failures.length) {
        const first = failures.reduce((a, b) => (b.index < a.index ? b : a));
        const point = points[first.index];
        throw new PreflightError(point.shot, point.edge, point.frame, first.error);
      }
      return made.filter((m) => m !== undefined);
    });
  } finally {
    if (!input.keepIn) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Chosen frames of a reel as PNG stills, drawn by the same composition with
 * the same props as `renderReel` (ADR 0053): the acceptance harness compares
 * them with the frames of the exported MP4 ("preview matches export") and
 * reads titles off them. Files are named `frame-<n>.png` in `dir`.
 */
export async function renderReelStills(input: { timeline: Timeline; assets: Record<string, ReelAsset>; frames: number[]; dir: string; width?: number; watermark?: boolean; timeoutMs?: number }): Promise<Map<number, string>> {
  const serveUrl = await getServeUrl();
  const timeline = isInstagramMusic(input.timeline.music) ? { ...input.timeline, music: null } : input.timeline;
  const inputProps = { timeline, assets: input.assets, watermark: input.watermark ?? false };
  return withBrowser(async (puppeteerInstance) => {
    const composition = await selectComposition({ serveUrl, id: REEL_COMPOSITION_ID, inputProps, puppeteerInstance });
    const out = new Map<number, string>();
    for (const frame of [...new Set(input.frames)].filter((f) => f >= 0 && f < composition.durationInFrames)) {
      const output = path.join(input.dir, `frame-${frame}.png`);
      await renderStill({
        chromiumOptions: chromiumOptions(),
        composition, serveUrl, inputProps, output, frame, imageFormat: "png", puppeteerInstance,
        scale: (input.width ?? 540) / 1080,
        timeoutInMilliseconds: input.timeoutMs ?? 30_000,
        offthreadVideoCacheSizeInBytes: 256 * 1024 * 1024,
      });
      out.set(frame, output);
    }
    return out;
  });
}
