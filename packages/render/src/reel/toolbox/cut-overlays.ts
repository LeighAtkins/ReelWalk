import type { Clip } from "@reelwalk/core";

/**
 * Where the light leaks of the "lightLeak" cuts go (ADR 0082): an overlay centred on each such cut, which stays a hard
 * cut on its saved frame (the leak only hides it at its brightest), so the reel's length, titles and beats do not
 * move. A leak never runs past the reel's ends and is shortened to fit between the cuts either side of it.
 */
export const LIGHT_LEAK_FRAMES_30 = 24;

export type CutOverlay = { clipId: string; from: number; durationInFrames: number };

export function lightLeakOverlays(clips: readonly { clip: Pick<Clip, "id" | "transitionIn">; from: number; durationInFrames: number }[], fps: number, totalFrames: number): CutOverlay[] {
  const wanted = Math.max(2, Math.round((LIGHT_LEAK_FRAMES_30 * fps) / 30));
  const overlays: CutOverlay[] = [];
  clips.forEach((entry, index) => {
    if (index === 0 || entry.clip.transitionIn !== "lightLeak") return;
    const half = Math.min(Math.floor(wanted / 2), clips[index - 1].durationInFrames, entry.durationInFrames);
    const from = Math.max(0, entry.from - half);
    const end = Math.min(totalFrames, entry.from + half);
    if (end - from >= 2) overlays.push({ clipId: entry.clip.id, from, durationInFrames: end - from });
  });
  return overlays;
}
