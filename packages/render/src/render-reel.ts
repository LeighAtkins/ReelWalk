import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { Timeline } from "@reelwalk/core";
import { REEL_COMPOSITION_ID, type ReelAsset } from "./reel/types";
import { renderConcurrency } from "./concurrency";

let bundled: Promise<string> | null = null;

/**
 * Webpack-bundling the compositions takes several seconds. Reel assets are
 * passed as URLs rather than copied into the bundle, so one bundle serves every
 * render this process does.
 */
function getServeUrl(): Promise<string> {
  if (!bundled) {
    const entryPoint = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
    bundled = bundle({ entryPoint, webpackOverride: (config) => config }).catch((error) => {
      bundled = null;
      throw error;
    });
  }
  return bundled;
}

export async function renderReel(
  input: { timeline: Timeline; assets: Record<string, ReelAsset>; output: string; concurrency?: number },
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const serveUrl = await getServeUrl();
  const inputProps = { timeline: input.timeline, assets: input.assets };
  const composition = await selectComposition({ serveUrl, id: REEL_COMPOSITION_ID, inputProps });

  const outputLocation = path.resolve(input.output);
  // Instagram re-encodes every upload, so start from a high-quality source:
  // H.264, yuv420p, AAC, 30 fps, 1080x1920. Remotion adds +faststart for H.264.
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    crf: 18,
    audioBitrate: "192k",
    pixelFormat: "yuv420p",
    // Limited-range BT.709, the standard for web video. Without it the output
    // is full-range (yuvj420p), which some players show with shifted colours.
    colorSpace: "bt709",
    inputProps,
    outputLocation,
    concurrency: renderConcurrency(input.concurrency, os.availableParallelism()),
    // Inside a container Remotion sizes these caches from the host's memory,
    // not the cgroup limit, and the compositor gets killed. Fixed, modest
    // caches instead; 1080p sources do not need more.
    offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024,
    mediaCacheSizeInBytes: 512 * 1024 * 1024,
    onProgress: ({ progress }) => onProgress?.(progress),
  });
  return outputLocation;
}
