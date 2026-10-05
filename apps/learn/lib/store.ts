"use client";

import { useCallback, useEffect, useState } from "react";

const PREFIX = "reelwalk-learn:";
const listeners = new Map<string, Set<() => void>>();

export function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: progress just isn't kept.
  }
  listeners.get(key)?.forEach((fn) => fn());
}

/**
 * State persisted in localStorage and shared by every component using the same key.
 * Starts at `fallback` on the server and the first client render, then loads,
 * so static HTML and hydration agree.
 */
export function useLocal<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const sync = () => setValue(readLocal(key, fallback));
    sync();
    setLoaded(true);
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(sync);
    return () => {
      set.delete(sync);
    };
  }, [key]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = readLocal(key, fallback);
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      writeLocal(key, resolved);
    },
    [key],
  );

  return [value, update, loaded];
}
