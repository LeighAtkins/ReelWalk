import type { CriticFrame, CriticSample } from "@reelwalk/core";

/**
 * Reading the critic's frames (ADR 0062), framework-free so it can be tested
 * without a DOM. One run reads the samples in order and stops as soon as it
 * is no longer wanted. A source that fails once (unreadable, no CORS, a 360
 * photo, a read that takes too long) is recorded in `failed` and skipped for
 * the rest of the run and for later runs that share the set, so one bad
 * video costs one timeout, not one per sample.
 */

export type CriticFrameEntry = { frame: CriticFrame; thumb: string | null };

/** Longest one frame may take before its source is given up on (a phone seek is well under a second). */
export const CRITIC_READ_TIMEOUT_MS = 8_000;

export type CriticFrameRun<C> = {
  /** The cache key of a sample (its moment and the clip as presented). */
  keyOf(sample: CriticSample): string;
  /** The media a sample is drawn from; null when the clip's media is unknown. */
  sourceOf(sample: CriticSample): string | null;
  cache: Map<string, CriticFrameEntry>;
  /** Sources that failed: shared across runs while the sheet is open. */
  failed: Set<string>;
  /** Draws the sample (the frame service); null when it cannot. */
  draw(sample: CriticSample): Promise<C | null>;
  /** Reads the drawn picture back; throws when it cannot (a tainted canvas). */
  read(canvas: C): CriticFrameEntry;
  /** False once the run is no longer wanted (the reel changed, the sheet closed). */
  live(): boolean;
  timeoutMs?: number;
  maxCached?: number;
};

const TIMED_OUT = Symbol("timed out");

/** Reads every sample not cached yet. Returns how many were read and how many were skipped for a failed source. */
export async function readCriticFrames<C>(samples: readonly CriticSample[], run: CriticFrameRun<C>): Promise<{ read: number; skipped: number; cancelled: boolean }> {
  let read = 0, skipped = 0;
  for (const sample of samples) {
    if (!run.live()) return { read, skipped, cancelled: true };
    const key = run.keyOf(sample);
    if (run.cache.has(key)) continue;
    const source = run.sourceOf(sample);
    if (!source || run.failed.has(source)) { skipped++; continue; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), run.timeoutMs ?? CRITIC_READ_TIMEOUT_MS); });
    const drawn = await Promise.race([run.draw(sample).catch(() => null), timeout]);
    clearTimeout(timer);
    if (!run.live()) return { read, skipped, cancelled: true };
    if (drawn === TIMED_OUT || drawn === null) { run.failed.add(source); continue; }
    try {
      run.cache.set(key, run.read(drawn));
      read++;
    } catch {
      // A tainted canvas (media without CORS) fails for every frame of that source.
      run.failed.add(source);
      continue;
    }
    while (run.cache.size > (run.maxCached ?? Infinity)) run.cache.delete(run.cache.keys().next().value!);
  }
  return { read, skipped, cancelled: false };
}
