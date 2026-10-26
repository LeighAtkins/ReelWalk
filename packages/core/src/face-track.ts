/**
 * Where the presenter's face goes through a take (ADR 0089 round 3), for keyword lockups that follow her head. The
 * identity gate finds her face once, on the composed first frame (ADR 0056); a walking take moves it. This follows that
 * box with the surface tracker (ADR 0052): the middle of the face (eyes, nose, mouth, hairline edges) is a small,
 * textured, nearly flat patch, which the tracker's similarity and affine models follow well. The tracker refuses rather
 * than guesses; where it loses the face the track ends, and the lockup holds the last place it knew.
 *
 * Pure: frames in, samples out. The worker decodes the take's frames (ffmpeg) and stores the samples with the gate's record.
 */
import type { Gray, Quad } from "./motion";
import { trackSurface, type TrackOptions } from "./track";
import type { FaceSample } from "./keyword-lockup";

/** The patch tracked: the face box's middle, so hair edges and the background behind her stay out of it. */
const PATCH_INSET_X = 0.18, PATCH_INSET_Y = 0.12;
/**
 * A frame the tracker is less sure of than this is left out (the samples either side are interpolated across it): her
 * mouth moving while she talks drops single frames' confidence without the face going anywhere.
 */
const MIN_CONFIDENCE = 0.2;

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * The face box (source fractions) at each sure frame's time, from the gate's `seed` box on frame 0: the box moves and
 * scales with the tracked patch. Unsure frames are skipped; the track ends where the tracker lost her. Null when it could
 * not start (too few features on the face, a frame list too short).
 */
export function trackFace(frames: readonly Gray[], timesMs: readonly number[], seed: Box, options: TrackOptions = {}): FaceSample[] | null {
  if (frames.length < 2 || frames.length !== timesMs.length) return null;
  const { width, height } = frames[0];
  const w = seed.x1 - seed.x0, h = seed.y1 - seed.y0;
  if (!(w > 0 && h > 0)) return null;
  const px = (fx: number, fy: number): [number, number] => [fx * width, fy * height];
  const left = seed.x0 + PATCH_INSET_X * w, right = seed.x1 - PATCH_INSET_X * w, top = seed.y0 + PATCH_INSET_Y * h, bottom = seed.y1 - PATCH_INSET_Y * h;
  const quad = [...px(left, top), ...px(right, top), ...px(right, bottom), ...px(left, bottom)] as Quad;
  const result = trackSurface([...frames], [{ index: 0, quad }], { window: 4, margin: 3, minPoints: 6, maxPoints: 60, minCorner: 4, ...options });
  if (!result.ok) return null;
  const samples: FaceSample[] = [];
  for (const frame of result.frames) {
    if (frame.index > 0 && frame.lost) break;
    if (frame.index > 0 && (frame.held || frame.confidence < MIN_CONFIDENCE)) continue;
    const xs = [frame.quad[0], frame.quad[2], frame.quad[4], frame.quad[6]].map((x) => x / width);
    const ys = [frame.quad[1], frame.quad[3], frame.quad[5], frame.quad[7]].map((y) => y / height);
    // The patch's box, grown back to the face's: the patch is the same share of the face in every frame.
    const pw = Math.max(...xs) - Math.min(...xs), ph = Math.max(...ys) - Math.min(...ys);
    const fw = pw / (1 - 2 * PATCH_INSET_X), fh = ph / (1 - 2 * PATCH_INSET_Y);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const round = (v: number) => Number(v.toFixed(4));
    samples.push({ ms: Math.round(timesMs[frame.index]), x0: round(cx - fw / 2), y0: round(cy - fh / 2), x1: round(cx + fw / 2), y1: round(cy + fh / 2) });
  }
  return samples.length >= 2 ? samples : null;
}
