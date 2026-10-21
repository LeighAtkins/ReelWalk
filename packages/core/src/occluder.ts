/**
 * Where a tapped object was when it was tapped (ADR 0051). Taps are stored in
 * the pin's first-frame coordinates (the editor takes the tap back through the
 * wall's motion). For a wall-mounted thing that is the whole story; for an
 * object moving on its own, the point tracker needs the frame the author
 * actually tapped and where on it, which `atMs` records.
 */
import { locateFrame, textQuadAt } from "./cinematic";
import { applyHomography, homography, type Quad } from "./motion";
import { REEL_FORMAT, type Clip, type TextOverlay, type Timeline } from "./timeline";

/**
 * The source time (seconds) a clip shows on its frame `n`: the one formula the
 * composition's mattes seek by, so a picture named by it is the picture drawn.
 */
export function clipSourceSeconds(clip: Pick<Clip, "sourceStartMs" | "speed">, n: number, fps: number = REEL_FORMAT.fps): number {
  return clip.sourceStartMs / 1000 + (n / fps) * (clip.speed || 1);
}

/**
 * The pinned asset's source time (ms, not rounded) of the frame on screen at
 * `reelMs`, from the composition's own frame plan and `clipSourceSeconds`, kept
 * inside the pin's window; null when the title is not pinned to the clip on
 * screen. Rounding it to whole ms named the frame before (2033.33 → 2033).
 */
export function tapSourceMs(timeline: Timeline, text: TextOverlay, reelMs: number, fps: number = REEL_FORMAT.fps): number | null {
  if (!text.pin) return null;
  const at = locateFrame(timeline, reelMs, fps);
  const clip = at ? timeline.clips[at.index] : null;
  if (!at || !clip || clip.kind !== "VIDEO" || clip.assetId !== text.pin.assetId) return null;
  const n = Math.round((at.offsetMs * fps) / 1000);
  return clampToPin(text.pin, clipSourceSeconds(clip, n, fps) * 1000);
}

function clampToPin(pin: { fromMs: number; toMs: number }, ms: number): number {
  return Math.min(Math.max(pin.fromMs, pin.toMs), Math.max(pin.fromMs, ms));
}

/**
 * A tap's own frame and point: the stored first-frame point carried by the wall to
 * the frame it was made on, which gives back where the author's finger was. Null
 * for a tap with no recorded time (older taps) or a title without a pinned plane.
 * The time is kept inside the pin's window, so it never names a frame past the file.
 */
export function tapReference(text: TextOverlay, tap: { x: number; y: number; atMs?: number }): { sourceMs: number; x: number; y: number } | null {
  if (tap.atMs === undefined || !text.pin?.quad) return null;
  const sourceMs = clampToPin(text.pin, tap.atMs);
  const span = text.pin.toMs - text.pin.fromMs;
  const quad = textQuadAt(text, span > 0 ? (sourceMs - text.pin.fromMs) / span : 0);
  const H = quad ? homography(text.pin.quad as Quad, quad as Quad) : null;
  if (!H) return { sourceMs, x: tap.x, y: tap.y };
  const [x, y] = applyHomography(H, tap.x, tap.y);
  return { sourceMs, x, y };
}
