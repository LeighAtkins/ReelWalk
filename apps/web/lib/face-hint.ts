/**
 * The presenter's face as the identity gate (ADR 0056) left it, for
 * Inspect's Face chip (ADR 0057). Kept in lib, free of imports: the library
 * code reads it, and the worker image copies apps/web/lib alone.
 */

/**
 * Where the identity gate found the presenter's face on the composed first
 * frame (ADR 0056), in source fractions of the take: a box when one is
 * stored, else only its height. Null when the gate left nothing.
 */
export type FaceHint = { box: { x0: number; y0: number; x1: number; y1: number } | null; heightFraction: number | null };

/** The composite the gate measures is 1080×1920 (worker/identity.ts `faceHeightFromBox`). */
const GATE_IMAGE_HEIGHT = 1920;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A located box as the gate keeps it: [ymin, xmin, ymax, xmax] on the 0–1000 grid of the composite. */
function gridBox(raw: unknown): FaceHint["box"] {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [ymin, xmin, ymax, xmax] = (raw as number[]).map((n) => clamp(n / 1000, 0, 1));
  return ymax > ymin && xmax > xmin ? { x0: xmin, y0: ymin, x1: xmax, y1: ymax } : null;
}

/**
 * Reads a face hint from a generation's `identityChecks` (worker
 * ai-video.ts `IdentityCheck`), newest first-frame check first: the box of
 * its last locate attempt that found a face (`locate[].box`, kept unless it
 * was rejected as not a face; a face only too small to judge is still where
 * she is), else the measured `faceHeightPx` alone. Null when neither exists.
 */
export function faceHintFromChecks(checks: unknown): FaceHint | null {
  if (!Array.isArray(checks)) return null;
  const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null) : []);
  const first = records(checks).filter((c) => c.end === "first").reverse();
  for (const check of first) {
    const located = records(check.locate).reverse().find((attempt) => (attempt.rejected === undefined || attempt.rejected === "face-too-small") && gridBox(attempt.box));
    const box = located ? gridBox(located.box) : null;
    if (box) return { box, heightFraction: box.y1 - box.y0 };
  }
  for (const check of first) {
    const px = typeof check.faceHeightPx === "number" && check.faceHeightPx > 0 ? check.faceHeightPx : null;
    if (px) return { box: null, heightFraction: Math.min(1, px / GATE_IMAGE_HEIGHT) };
  }
  return null;
}
