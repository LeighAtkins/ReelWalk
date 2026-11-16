import { clipDurationMs, clipStartsMs, locate, type TextOverlay, type Timeline } from "@reelwalk/core";

/** Converting a flat title explicitly replaces its incompatible tracking/effects. */
export function physicalTextEdit(timeline: Timeline, atMs: number, previous?: TextOverlay): Partial<TextOverlay> {
  const location = locate(timeline, previous?.startMs ?? atMs);
  if (!location) throw new Error("Add a shot before placing physical text.");
  const startMs = clipStartsMs(timeline)[location.index];
  return {
    pin: undefined, surface: undefined, bars: undefined, cutouts: undefined, occluders: undefined,
    path: undefined, fill: undefined, behind: undefined, callout: undefined, kinetic: undefined,
    shine: undefined, particles: undefined, brand: undefined, lockup: undefined,
    animation: "none",
    ...(!previous?.physical3d ? { startMs, endMs: startMs + clipDurationMs(timeline.clips[location.index]) } : {}),
  };
}
