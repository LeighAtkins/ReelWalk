import { useState, useSyncExternalStore } from "react";
import type { BrandKit, Timeline } from "@reelwalk/core";
import { createDocumentStore } from "./document-store";

export { STALE_PROPOSAL } from "./document-store";

/**
 * The editor's document (ADR 0048) as a React hook: the store in
 * document-store.ts, rendered whenever the reel changes. `sourceDurationsMs`
 * is read at each command, so pass a stable function over a ref.
 */
export function useDocument(initial: Timeline, sourceDurationsMs: () => Record<string, number | null | undefined>, brandKit?: () => BrandKit | null) {
  const [store] = useState(() => createDocumentStore(initial, sourceDurationsMs, brandKit));
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return {
    history: state.history,
    generation: state.generation,
    dispatch: store.dispatch,
    runCommand: store.runCommand,
    snapshot: store.snapshot,
    endGesture: store.endGesture,
  };
}
