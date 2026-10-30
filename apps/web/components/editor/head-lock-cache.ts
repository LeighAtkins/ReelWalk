import type { HeadLock } from '@reelwalk/core';

const hashes = new WeakMap<HeadLock, string>();

/** Tracks are immutable document values. Hash once, rather than serialising 400 keys on every seek. */
export function headLockFrameKey(lock?: HeadLock | null): string {
  if (!lock) return '';
  const cached = hashes.get(lock);
  if (cached) return cached;
  let hash = 0x811c9dc5;
  const text = JSON.stringify(lock);
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  const key = (hash >>> 0).toString(16);
  hashes.set(lock, key);
  return key;
}
