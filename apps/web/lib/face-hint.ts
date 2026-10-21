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

/**
 * Reads a face hint from a generation's `identityChecks`: the latest check of
 * the composed first frame. The gate stores `faceHeightPx` today; a `faceBox`
 * ([ymin, xmin, ymax, xmax] on a 0–1000 grid, the gate's own format) is used
 * when a check carries one.
 */
export function faceHintFromChecks(checks: unknown): FaceHint | null {
  if (!Array.isArray(checks)) return null;
  const first = checks.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && (c as Record<string, unknown>).end === "first");
  for (const check of first.reverse()) {
    const raw = check.faceBox;
    let box: FaceHint["box"] = null;
    if (Array.isArray(raw) && raw.length === 4 && raw.every((n) => typeof n === "number" && Number.isFinite(n))) {
      const [ymin, xmin, ymax, xmax] = (raw as number[]).map((n) => clamp(n / 1000, 0, 1));
      if (ymax > ymin && xmax > xmin) box = { x0: xmin, y0: ymin, x1: xmax, y1: ymax };
    }
    const px = typeof check.faceHeightPx === "number" && check.faceHeightPx > 0 ? check.faceHeightPx : null;
    const heightFraction = box ? box.y1 - box.y0 : px ? Math.min(1, px / GATE_IMAGE_HEIGHT) : null;
    if (box || heightFraction) return { box, heightFraction };
  }
  return null;
}
