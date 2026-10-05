import { useSyncExternalStore } from "react";

/**
 * The playhead position, outside React state. During playback it changes 30
 * times a second; only the few components that show it subscribe, so the rest
 * of the editor does not re-render on every frame.
 */
export type Clock = {
  get(): number;
  set(ms: number, source: "player" | "scrub" | "seek"): void;
  subscribe(listener: (ms: number, source: "player" | "scrub" | "seek") => void): () => void;
};

export function createClock(): Clock {
  let value = 0;
  const listeners = new Set<(ms: number, source: "player" | "scrub" | "seek") => void>();
  return {
    get: () => value,
    set(ms, source) {
      if (ms === value) return;
      value = ms;
      for (const listener of listeners) listener(ms, source);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useClock(clock: Clock): number {
  return useSyncExternalStore(
    (onChange) => clock.subscribe(() => onChange()),
    clock.get,
    () => 0,
  );
}
