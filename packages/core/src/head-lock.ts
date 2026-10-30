import { z } from "zod";
import type { FaceSample } from "./keyword-lockup";

const unit = z.number().min(0).max(1);
export const headLockSchema = z.object({
  version: z.literal(1),
  target: z.object({ x: unit, y: unit }),
  referenceHeight: z.number().min(.02).max(1),
  zoom: z.number().min(1).max(3),
  /** Source milliseconds; x/y and height are fractions of the original cover-fit picture. */
  keys: z.array(z.object({ ms: z.number().nonnegative(), x: unit, y: unit, height: z.number().min(.02).max(1) })).min(2).max(400),
}).refine(h => h.keys.every((k, i) => !i || k.ms > h.keys[i - 1].ms), "Head samples must be in time order");
export type HeadLock = z.infer<typeof headLockSchema>;

/** Minimum constant crop that fills every edge, including height compensation.
 * Between keys each bound is a ratio of linear functions: its maximum is at an endpoint. */
export function requiredHeadLockZoom({ keys, target, referenceHeight }: Pick<HeadLock, "keys" | "target" | "referenceHeight">): number {
  const edge = (needed: number, room: number) => room > 0 ? needed / room : needed === 0 ? 0 : Infinity;
  return Math.max(1, ...keys.flatMap(k => {
    const ratio = referenceHeight / k.height;
    return [edge(target.x, ratio * k.x), edge(1 - target.x, ratio * (1 - k.x)), edge(target.y, ratio * k.y), edge(1 - target.y, ratio * (1 - k.y))];
  }));
}

/** Shared by source-window edits; tolerance covers the sampling endpoints. */
export function normaliseHeadLockWindow<T extends { sourceStartMs: number; sourceEndMs: number; headLock?: HeadLock | null }>(clip: T): T {
  const h = clip.headLock;
  return h && (clip.sourceStartMs < h.keys[0].ms - 50 || clip.sourceEndMs > h.keys.at(-1)!.ms + 80) ? { ...clip, headLock: null } : clip;
}

/** Refuse incomplete tracking rather than holding a lost face while the subject keeps moving. */
export function makeHeadLock(samples: readonly FaceSample[], source: { width: number; height: number }, fromMs: number, toMs: number): HeadLock {
  if (!(source.width > 0 && source.height > 0) || samples.length < 2 || samples.some((s, i) =>
    ![s.ms, s.x0, s.x1, s.y0, s.y1].every(Number.isFinite) || s.x1 <= s.x0 || s.y1 <= s.y0 ||
    (i > 0 && (s.ms <= samples[i - 1].ms || s.ms - samples[i - 1].ms > 180)))) throw new Error("The head track has gaps. Try a shorter clip with the face clearly visible.");
  if (samples[0].ms > fromMs + 50 || samples.at(-1)!.ms < toMs - 80) throw new Error("The head was lost before the clip ended. Trim the clip or track it again.");
  const rx = Math.max(1, (source.width / source.height) / (9 / 16));
  const ry = Math.max(1, (9 / 16) / (source.width / source.height));
  const raw = samples.map(s => ({ ms: s.ms, x: .5 + ((s.x0 + s.x1) / 2 - .5) * rx, y: .5 + ((s.y0 + s.y1) / 2 - .5) * ry, height: (s.y1 - s.y0) * ry }));
  if (raw.some(k => k.x <= .02 || k.x >= .98 || k.y <= .02 || k.y >= .98 || k.height > 1)) throw new Error("The head leaves the vertical crop. Reframe the source or choose a shorter section.");
  // Symmetric smoothing has no causal lag. Keep the bounce; remove only sub-frame jitter.
  const smooth = (at: number, field: "x" | "y" | "height", sigma: number) => {
    let sum = 0, weight = 0;
    for (const k of raw) {
      const d = (k.ms - at) / sigma;
      if (Math.abs(d) > 3) continue;
      const w = Math.exp(-d * d / 2); sum += k[field] * w; weight += w;
    }
    return sum / weight;
  };
  const round = (n: number) => Number(n.toFixed(4));
  const keys = raw.map(k => ({ ms: round(k.ms), x: round(smooth(k.ms, "x", 22)), y: round(smooth(k.ms, "y", 22)), height: round(smooth(k.ms, "height", 70)) }));
  const target = { x: .5, y: round(Math.max(.25, Math.min(.45, keys.reduce((s, k) => s + k.y, 0) / keys.length))) };
  const referenceHeight = round(keys.reduce((s, k) => s + k.height, 0) / keys.length);
  // One crop for the whole track, including scale compensation: no zoom pumping to hide edges.
  const zoom = Math.ceil(requiredHeadLockZoom({ keys, target, referenceHeight }) * 1.015 * 10000) / 10000;
  if (zoom > 3) throw new Error("This motion needs more than 3× crop. Choose a shorter section or film with more headroom.");
  return headLockSchema.parse({ version: 1, target, referenceHeight, zoom, keys });
}

/** Same camera transform in the editor, frame service, mattes and final render. */
export function headLockAt(lock: HeadLock, sourceMs: number, extraZoom = 1) {
  const bIndex = lock.keys.findIndex(k => k.ms >= sourceMs);
  const b = lock.keys[bIndex < 0 ? lock.keys.length - 1 : bIndex];
  const a = lock.keys[Math.max(0, bIndex < 0 ? lock.keys.length - 1 : bIndex - 1)];
  const p = b.ms === a.ms ? 0 : Math.max(0, Math.min(1, (sourceMs - a.ms) / (b.ms - a.ms)));
  const x = a.x + (b.x - a.x) * p, y = a.y + (b.y - a.y) * p;
  const height = a.height + (b.height - a.height) * p;
  const scale = lock.zoom * lock.referenceHeight / height * extraZoom;
  return { scale, x: ((lock.target.x - .5) / scale - (x - .5)) * 100, y: ((lock.target.y - .5) / scale - (y - .5)) * 100 };
}
