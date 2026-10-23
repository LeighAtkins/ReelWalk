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
  /**
   * The source video's length, when known (ADR 0073): a speed-ramp cut reads past a clip's out-point only as far as the
   * file goes. Unknown (older callers) means no source beyond the out-point is assumed, and the preview and the export
   * must be given the same figure so they ramp the same way.
   */
  durationMs?: number | null;
};

export type ReelProps = {
  timeline: Timeline;
  assets: Record<string, ReelAsset>;
  /** Free-plan exports carry the ReelWalk mark; the editor preview never does. */
  watermark?: boolean;
};
