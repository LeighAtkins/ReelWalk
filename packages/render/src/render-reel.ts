import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, renderStill, selectComposition, type CancelSignal, type OpenGlRenderer as GlRenderer } from "@remotion/renderer";
import { clipDurationMs, clipStartsMs, isInstagramMusic, REEL_FORMAT, type Timeline } from "@reelwalk/core";
import { mkdtemp, rm } from "node:fs/promises";
import { REEL_COMPOSITION_ID, type ReelAsset } from "./reel/types";
import { renderConcurrency } from "./concurrency";

let bundled: Promise<string> | null = null;

/**
 * Chrome's GL backend for the render (`REELWALK_RENDER_GL`, a Remotion `gl` value such as "swangle"), unset by default so
 * nothing changes. A zoom blur (ADR 0074) is displacement-map filters, which software GL runs several times slower than
 * the Gaussian of the other transitions; on the machine measured, "swangle" took its export from 1.84× to 1.24× the
 * plain-cut one. Unverified on the Linux worker, which is why it is a switch and not the default.
 */
function chromiumOptions(): { gl: GlRenderer } | undefined {
  const gl = process.env.REELWALK_RENDER_GL?.trim();
  return gl ? { gl: gl as GlRenderer } : undefined;
}

/**
 * Webpack-bundling the compositions takes several seconds. Reel assets are
 * passed as URLs rather than copied into the bundle, so one bundle serves every
 * render this process does.
 */
function getServeUrl(): Promise<string> {
  if (!bundled) {
    const entryPoint = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
    // The bundled sound set (ADR 0066) is served from the package's public dir, so `staticFile("sfx/…")` resolves in the worker.
    const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
    bundled = bundle({ entryPoint, publicDir, webpackOverride: (config) => config }).catch((error) => {
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
  const composition = await selectComposition({ serveUrl, id: REEL_COMPOSITION_ID, inputProps });

  input.signal?.throwIfAborted();
  const outputLocation = path.resolve(input.output);
  const cancel = remotionCancel(input.signal);
  // Instagram re-encodes every upload, so start from a high-quality source:
  // H.264, yuv420p, AAC, 30 fps, 1080x1920. Remotion adds +faststart for H.264.
  await renderMedia({
    chromiumOptions: chromiumOptions(),
    composition,
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
 * Before a full render, draw the first and last frame of every shot as stills
 * (ADR 0042). A frame that errors or hangs fails here in seconds, naming the
 * shot, instead of minutes into the render. Returns the still paths when
 * `keepIn` is given (the smoke test lays them out); otherwise they are removed.
 */
export async function preflightReel(
  input: { timeline: Timeline; assets: Record<string, ReelAsset>; keepIn?: string; timeoutMs?: number; width?: number; signal?: AbortSignal },
  onProgress?: (done: number, total: number) => void,
): Promise<{ frame: number; shot: number; edge: CheckpointEdge; path: string }[]> {
  const serveUrl = await getServeUrl();
  input.signal?.throwIfAborted();
  const timeline = isInstagramMusic(input.timeline.music) ? { ...input.timeline, music: null } : input.timeline;
  const inputProps = { timeline, assets: input.assets, watermark: false };
  const composition = await selectComposition({ serveUrl, id: REEL_COMPOSITION_ID, inputProps });
  const points = reelCheckpoints(timeline, composition.fps).filter((p) => p.frame < composition.durationInFrames);
  const dir = input.keepIn ?? (await mkdtemp(path.join(os.tmpdir(), "reelwalk-preflight-")));
  const made: { frame: number; shot: number; edge: CheckpointEdge; path: string }[] = [];
  try {
    for (const [index, point] of points.entries()) {
      const output = path.join(dir, `shot-${String(point.shot).padStart(2, "0")}-${point.edge}.jpg`);
      input.signal?.throwIfAborted();
      const cancel = remotionCancel(input.signal);
      try {
        await renderStill({
          chromiumOptions: chromiumOptions(),
          composition, serveUrl, inputProps, output, frame: point.frame, imageFormat: "jpeg", jpegQuality: 80,
          scale: (input.width ?? 540) / 1080,
          timeoutInMilliseconds: input.timeoutMs ?? 30_000,
          offthreadVideoCacheSizeInBytes: 256 * 1024 * 1024,
          cancelSignal: cancel.cancelSignal,
        });
      } catch (error) {
        // A cancelled preflight is not a broken shot: report the cancellation as it is.
        if (input.signal?.aborted) throw input.signal.reason;
        throw new PreflightError(point.shot, point.edge, point.frame, error);
      } finally {
        cancel.done();
      }
      made.push({ ...point, path: output });
      onProgress?.(index + 1, points.length);
    }
    return made;
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
  const composition = await selectComposition({ serveUrl, id: REEL_COMPOSITION_ID, inputProps });
  const out = new Map<number, string>();
  for (const frame of [...new Set(input.frames)].filter((f) => f >= 0 && f < composition.durationInFrames)) {
    const output = path.join(input.dir, `frame-${frame}.png`);
    await renderStill({
      chromiumOptions: chromiumOptions(),
      composition, serveUrl, inputProps, output, frame, imageFormat: "png",
      scale: (input.width ?? 540) / 1080,
      timeoutInMilliseconds: input.timeoutMs ?? 30_000,
      offthreadVideoCacheSizeInBytes: 256 * 1024 * 1024,
    });
    out.set(frame, output);
  }
  return out;
}
