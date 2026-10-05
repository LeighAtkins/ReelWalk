/** Browser tabs per render when nothing is configured. */
export const DEFAULT_RENDER_CONCURRENCY = 4;

/**
 * Browser tabs rendering in parallel. More is not faster: on a 24-core
 * machine 4 tabs beat Remotion's default of half the cores, because the tabs
 * compete for video decoding. Remotion rejects a value above the number of
 * cores, so on a small machine (a 2-core CI runner, a pod on a small node)
 * the request is capped instead of failing every render.
 */
export function renderConcurrency(requested: number | undefined, cores: number): number {
  const wanted = Number.isFinite(requested) && requested! >= 1 ? Math.floor(requested!) : DEFAULT_RENDER_CONCURRENCY;
  return Math.max(1, Math.min(wanted, Math.floor(cores) || 1));
}
