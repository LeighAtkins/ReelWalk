import type { Timeline, Transcript } from "@reelwalk/core";

// Kept apart from the composition: the worker's Node code imports these, and
// the composition module pulls in browser-only font CSS.

export const REEL_COMPOSITION_ID = "Reel";

export type ReelAsset = {
  /** Absolute URL (preview, worker) or a file name in the bundle's public dir. */
  src: string;
  kind: "VIDEO" | "IMAGE" | "AUDIO";
  /** Words with timings, for a video with speech: the music ducks under them. */
  transcript?: Transcript | null;
};

export type ReelProps = {
  timeline: Timeline;
  assets: Record<string, ReelAsset>;
  /** Free-plan exports carry the ReelWalk mark; the editor preview never does. */
  watermark?: boolean;
};
