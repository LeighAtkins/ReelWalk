import type { Timeline } from "@reelwalk/core";

// Kept apart from the composition: the worker's Node code imports these, and
// the composition module pulls in browser-only font CSS.

export const REEL_COMPOSITION_ID = "Reel";

export type ReelAsset = {
  /** Absolute URL (preview, worker) or a file name in the bundle's public dir. */
  src: string;
  kind: "VIDEO" | "IMAGE" | "AUDIO";
};

export type ReelProps = {
  timeline: Timeline;
  assets: Record<string, ReelAsset>;
};
