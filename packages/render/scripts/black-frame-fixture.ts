/**
 * The black-frame fixture (ADR 0067), pure so the render package's tests can
 * check it without a renderer: a reel whose cuts are the owner's, 20–30 ms
 * off a frame boundary at 30 fps, and the frames to look at around them.
 */
import { cameraPreset, framePlan, parseTimeline, rampPreset, type Timeline } from "@reelwalk/core";

export const FPS = 30;
/** The owner's cuts (ms): each 20–30 ms off a frame boundary at 30 fps (D1, D3, D4 of the 2026-10-21 series). */
export const CUTS = [3025, 11333, 22167];
/**
 * Where each shot starts in its source (ms). The first is 1020 ms: at 30 fps that is 30.6 frames, which rounds up,
 * while its end (1020 + 3025 = 4045 ms, 121.35 frames) rounds down, so a media window trimmed on the end time was
 * 90 frames for a 91-frame sequence: the shortfall the old composition had.
 */
export const SOURCE_STARTS = [1020, 500, 250, 1000];

export function blackFrameTimeline(): Timeline {
  const ends = [...CUTS, CUTS[CUTS.length - 1] + 2000];
  const lengths = ends.map((end, i) => end - (ends[i - 1] ?? 0));
  const clips = lengths.map((length, i) => ({
    id: `c${i + 1}`, assetId: ["a", "b", "c", "a"][i], kind: "VIDEO" as const, sourceStartMs: SOURCE_STARTS[i], sourceEndMs: SOURCE_STARTS[i] + length, transitionIn: "cut" as const, volume: 0,
    // The shot into the first cut races into it; the second settles with an eased push; the third whips in.
    ...(i === 0 ? { ramp: rampPreset("into-cut") } : {}),
    ...(i === 1 ? { camera: cameraPreset("push-settle") } : {}),
    ...(i === 2 ? { transitionIn: "whip" as const, whipDirection: "left" as const } : {}),
  }));
  return parseTimeline({
    version: 1,
    clips,
    texts: [{ id: "t1", text: "NO BLACK FRAMES", startMs: 0, endMs: ends[ends.length - 1], x: 0.5, y: 0.5, style: "headline", size: 1.2, animation: "none" }],
    music: null,
  });
}

/** The frames to look at: two before and two after each cut, and every shot's first and last frame. */
export function framesToCheck(timeline: Timeline): { frame: number; why: string }[] {
  const plan = framePlan(timeline, FPS);
  const out = new Map<number, string>();
  for (const [i, cut] of CUTS.entries()) {
    const f = plan.clips[i].from + plan.clips[i].durationInFrames;
    for (const d of [-2, -1, 0, 1]) out.set(f + d, `cut ${cut} ms ${d < 0 ? d : `+${d}`}`);
  }
  for (const entry of plan.clips) {
    out.set(entry.from, `${entry.clip.id} first`);
    out.set(entry.from + entry.durationInFrames - 1, `${entry.clip.id} last`);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([frame, why]) => ({ frame, why }));
}
