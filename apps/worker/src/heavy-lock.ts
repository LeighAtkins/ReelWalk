import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The shared-PC heavy lock (ADR 0094). The owner's PC also runs other heavy
 * work (the Last Mile game's captures and builds, other agents' builds), and
 * they agree on one lock: a directory, taken with an atomic mkdir, holding an
 * owner.txt that names the holder and is refreshed while held. A local
 * render worker takes it around each render and releases it after.
 *
 * It never steals: a held lock is waited out however old its owner.txt is.
 * From inside a container the worker cannot see whether the holder's
 * processes are still running, which is what the protocol's stale rule needs.
 */
export type HeavyLockOptions = {
  /** The lock directory, e.g. /heavy/.heavy.lock (C:\dev\lm\.heavy.lock mounted). */
  dir: string;
  /** First word of owner.txt, e.g. reelwalk-local-worker. */
  owner: string;
  /** How often a held lock is checked again. */
  pollMs?: number;
  /** How often owner.txt is rewritten while held (the protocol asks for at most 5 minutes). */
  refreshMs?: number;
  /** After releasing, wait this long before taking it again, so the other side gets a turn. */
  cooldownMs?: number;
  log?: (message: string) => void;
  now?: () => Date;
};

export type HeavyLock = {
  /** Waits for the lock (until `signal` aborts) and returns its release. */
  acquire(label: string, signal?: AbortSignal): Promise<() => Promise<void>>;
};

export function createHeavyLock(options: HeavyLockOptions): HeavyLock {
  const { dir, owner, pollMs = 30_000, refreshMs = 4 * 60_000, cooldownMs = 60_000 } = options;
  const log = options.log ?? ((message) => console.log(message));
  const now = options.now ?? (() => new Date());
  const ownerFile = path.join(dir, "owner.txt");
  let releasedAt = 0;

  const line = (label: string, token: string) => `${owner} ${now().toISOString()} ${label} #${token}\n`;
  const ours = async (token: string) => (await readFile(ownerFile, "utf8").catch(() => "")).includes(`#${token}`);

  return {
    async acquire(label, signal) {
      const cooldown = releasedAt + cooldownMs - Date.now();
      if (cooldown > 0) await wait(cooldown, signal);
      let waitingSince: number | undefined;
      for (;;) {
        signal?.throwIfAborted();
        try {
          await mkdir(dir);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        if (waitingSince === undefined) {
          waitingSince = Date.now();
          const holder = (await readFile(ownerFile, "utf8").catch(() => "(no owner.txt yet)")).trim();
          log(`heavy-lock: ${label} waiting for ${dir}, held by ${holder}`);
        }
        await wait(pollMs, signal);
      }

      // owner.txt is written and read back in the same step as the mkdir, so the lock is never ownerless.
      const token = randomUUID();
      try {
        await writeFile(ownerFile, line(label, token));
        if (!(await ours(token))) throw new Error("owner.txt did not read back");
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw new Error(`heavy-lock: could not write ${ownerFile}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (waitingSince !== undefined) log(`heavy-lock: ${label} took the lock after ${Math.round((Date.now() - waitingSince) / 1000)}s`);

      // A refresh in flight is awaited before releasing: a read during its write sees an empty owner.txt.
      let refreshing: Promise<unknown> = Promise.resolve();
      const refresh = setInterval(() => {
        refreshing = ours(token).then((still) => (still ? writeFile(ownerFile, line(label, token)) : undefined)).catch(() => undefined);
      }, refreshMs);
      refresh.unref?.();

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(refresh);
        await refreshing;
        // Only our own lock is removed: if owner.txt names someone else, the directory is theirs.
        if (await ours(token)) await rm(dir, { recursive: true, force: true });
        releasedAt = Date.now();
      };
    },
  };
}

/** Sleeps, or throws the stop reason (not a bare AbortError) if the attempt is stopped meanwhile. */
async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  await sleep(ms, undefined, { signal }).catch((error: unknown) => {
    signal?.throwIfAborted();
    throw error;
  });
}

/** The lock's parent must exist (the mount is there), or every render would fail on mkdir. */
export async function checkHeavyLockDir(dir: string): Promise<void> {
  const parent = path.dirname(dir);
  const info = await stat(parent).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`HEAVY_LOCK_DIR's parent ${parent} is not a directory; mount C:\\dev\\lm there or unset HEAVY_LOCK_DIR`);
}
