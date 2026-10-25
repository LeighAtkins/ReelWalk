import {
  clipDurationMs, clipSourceMsAt, findSurfaces, pickCandidate, presentGray, titleAspect, trackSampling, trackTitleFromFrames,
  type Clip, type SurfaceCandidate, type SurfaceHints, type SurfacePick, type SurfaceSearch, type TextOverlay, type TitleOnSurface, type TrackQuality,
} from "@reelwalk/core";
import { presentedJpeg, readSourceFrame, readTrackingFrames, type SurfaceSource } from "@/lib/surface-server";
import type { SurfaceLookResult } from "@/lib/surface-vision";

/**
 * "Put text on a surface" for callers with no browser (ADR 0075): the commands route's `placeOnSurface`. The
 * frame is read with ffmpeg, the model (when one is configured) names the surfaces, `findSurfaces` puts them on
 * real edges and ranks them, and, if the surface has detail to follow, the same tracker the editor's Pin uses
 * (`trackTitleFromFrames`) follows it through the shot. `look` is injected so tests run without a model.
 */
export type SurfaceTarget = {
  source: SurfaceSource;
  clip: Clip;
  /** Where the clip starts in the reel, ms. */
  clipStartMs: number;
  text: Pick<TextOverlay, "text" | "tracking">;
  /** The reel time of the frame to look at, ms. */
  atMs: number;
};

export type SurfaceLook = (jpeg: Buffer) => Promise<SurfaceLookResult>;

export type VisionReport = { used: boolean; model?: string; costUsd?: number; ms?: number; regions?: number; error?: string };

export type SurfaceFound = { search: SurfaceSearch; sourceMs: number; vision: VisionReport };

/** The source time of a reel time inside a clip, kept inside the clip's window (a frame short of its end). */
export function sourceTimeAt(clip: Clip, clipStartMs: number, atMs: number): number {
  const offset = Math.max(0, Math.min(clipDurationMs(clip) - 1, atMs - clipStartMs));
  return Math.max(clip.sourceStartMs, Math.min(clip.sourceEndMs - 40, clipSourceMsAt(clip, offset)));
}

/** The surfaces in the frame at `atMs`: dry-run's answer, and the first half of placing. */
export async function searchSurfaces(target: SurfaceTarget, options: { look?: SurfaceLook | null; top?: number } = {}): Promise<SurfaceFound> {
  const sourceMs = sourceTimeAt(target.clip, target.clipStartMs, target.atMs);
  const frame = presentGray(await readSourceFrame(target.source, sourceMs), target.clip, sourceMs);
  let hints: SurfaceHints = {};
  const vision: VisionReport = { used: false };
  if (options.look) {
    try {
      const looked = await options.look(await presentedJpeg(target.source, target.clip, sourceMs));
      hints = looked.hints;
      Object.assign(vision, { used: true, model: looked.model, costUsd: looked.costUsd, ms: looked.ms, regions: looked.hints.regions?.length ?? 0 });
    } catch (error) {
      // No model, or it could not answer: the geometry alone still proposes what it can.
      vision.error = error instanceof Error ? error.message : String(error);
    }
  }
  const aspect = titleAspect(target.text.text, target.text.tracking !== undefined ? { tracking: target.text.tracking } : {});
  return { search: findSurfaces(frame, { aspect }, hints, { top: options.top ?? 3 }), sourceMs, vision };
}

export type PlaceOutcome =
  | {
      ok: true;
      /** What to write into the title. */
      placement: TitleOnSurface;
      candidate: SurfaceCandidate;
      /** "tracked": followed through the shot. "fixed": placed, not followed (the surface has no detail, or the title is on a photo). "failed": the tracker could not follow it, so it is placed fixed. */
      tracking: "tracked" | "fixed" | "failed";
      quality?: TrackQuality;
      notes: string[];
      search: SurfaceSearch;
      vision: VisionReport;
    }
  | { ok: false; message: string; search: SurfaceSearch; vision: VisionReport };

const centre = (corners: readonly number[]): [number, number] => [(corners[0] + corners[2] + corners[4] + corners[6]) / 4, (corners[1] + corners[3] + corners[5] + corners[7]) / 4];

/**
 * Find a surface of the kind asked for, lay the title on it and, when it can be followed, track it through
 * the whole shot. Never drops the title: when nothing can be tracked the placement is fixed and says so.
 */
export async function placeOnSurface(target: SurfaceTarget, options: { pick?: SurfacePick; track?: boolean; look?: SurfaceLook | null } = {}): Promise<PlaceOutcome> {
  const { search, vision, sourceMs } = await searchSurfaces(target, { look: options.look, top: 6 });
  const candidate = pickCandidate(search.candidates, options.pick ?? "auto");
  if (!candidate) {
    const kinds = search.candidates.map((c) => c.kind);
    return {
      ok: false, search, vision,
      message: options.pick && options.pick !== "auto" && kinds.length
        ? `There is no ${options.pick} in that frame; it shows ${[...new Set(kinds)].join(", ")}. Pick one of those or "auto".`
        : "No surface in that frame could carry the title (nothing flat and large enough with room for the words at a size a phone can read). Try another moment of the shot, or give placement.corners yourself.",
    };
  }
  const notes: string[] = [];
  let placement: TitleOnSurface = { corners: candidate.placement, ink: { color: candidate.ink.color, shadow: candidate.ink.shadow } };
  let tracking: "tracked" | "fixed" | "failed" = "fixed";
  let quality: TrackQuality | undefined;
  const clip = target.clip;
  if (options.track === false) {
    notes.push("Placed without tracking, as asked.");
  } else if (clip.kind !== "VIDEO") {
    notes.push("The shot is a photo, so the title is placed and has nothing to follow.");
  } else if (candidate.tracking === "fixed") {
    notes.push(`The ${candidate.label.toLowerCase()} has too little detail for the tracker to hold on to (${candidate.texture.points} points, spread over ${Math.round(candidate.texture.coverage * 100)}% of the title), so the title is placed in perspective but does not follow the camera.`);
  } else {
    const [x, y] = centre(candidate.placement);
    const spanEnd = target.clipStartMs + clipDurationMs(clip);
    const title = { x, y, startMs: target.clipStartMs, endMs: spanEnd, surface: candidate.placement, support: candidate.plane };
    const sampling = trackSampling(clip, target.clipStartMs, title);
    if ("error" in sampling) {
      notes.push(sampling.error + " The title is placed without tracking.");
      tracking = "failed";
    } else {
      try {
        const { frames, times } = await readTrackingFrames(target.source, clip, sampling.fromMs, sampling.toMs, sampling.times.length);
        const tracked = await trackTitleFromFrames({ frames, times, assetId: clip.assetId, clip, clipStartMs: target.clipStartMs, text: title });
        if ("error" in tracked) {
          tracking = "failed";
          notes.push(`${tracked.error} The title is placed fixed in perspective instead: it will not follow the camera.`);
        } else {
          tracking = "tracked";
          quality = tracked.quality;
          placement = { ...placement, pinned: { path: tracked.path, pin: tracked.pin }, timing: { startMs: target.clipStartMs, endMs: spanEnd } };
          notes.push(`Followed the ${candidate.label.toLowerCase()} through the shot: ${tracked.quality.grade} track (${tracked.quality.inliers} points agreeing, confidence ${tracked.quality.confidence}).`);
          if (tracked.lostAtMs !== null) notes.push(`The surface is lost ${((tracked.lostAtMs - tracked.pin.fromMs) / 1000 / (clip.speed || 1)).toFixed(1)} s in, so the title fades there.`);
          if (tracked.quality.grade === "weak") notes.push("The track is weak: check the title across the shot before exporting.");
        }
      } catch (error) {
        tracking = "failed";
        notes.push(`The shot could not be read for tracking (${error instanceof Error ? error.message : "unknown"}); the title is placed fixed.`);
      }
    }
  }
  void sourceMs;
  return { ok: true, placement, candidate, tracking, quality, notes, search, vision };
}
