import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The shared-PC heavy lock (ADR 0094). The owner's PC also runs other heavy
 * work (the Last Mile game's captures and builds, other agents' builds), and
 * they agree on one lock: a directory, taken with an atomic mkdir, holding an
 * owner.txt that names the holder and is refreshed while held. A local
 * render worker takes it before each render and releases it after.
 *
 * It never steals. The one lock it may remove is one it can PROVE was left by
 * a dead process of its own: owner.txt names our owner, this very container
 * (its full id), and a process (PID and start time) that, seen from inside
 * this container, no longer exists, or a kernel boot that is not the current
 * one. Anything it cannot read or prove is left alone. Removal is a rename to
 * a tombstone (atomic), then a check that the tombstone holds exactly the
 * owner.txt that was judged dead; if not, the lock is put back. Our cleaners
 * (this worker and infra/local-worker/start.sh) also serialise on a sibling
 * `.cleanup` directory. Callers bound the wait with their signal.
 */

/** Who holds the lock, as owner.txt records it. */
export type Holder = { container: string; pid: number; start: string; boot: string };

/**
 * What a worker can see from inside its container: who it is, and whether a
 * process of this container still runs. Null means "cannot tell", which never
 * counts as dead.
 */
export type ProcessProbe = {
  self(): Promise<Holder | null>;
  alive(pid: number, start: string): Promise<boolean | null>;
};

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
  /** Reads /proc by default; tests stand in for it. */
  probe?: ProcessProbe;
};

export type HeavyLock = {
  /** Waits for the lock (until `signal` aborts) and returns its release. */
  acquire(label: string, signal?: AbortSignal): Promise<() => Promise<void>>;
};

/** Parses the identity fields of an owner.txt line; null if any is missing. */
export function parseHolder(line: string): Holder | null {
  const field = (name: string) => new RegExp(` ${name}=(\\S+)`).exec(line)?.[1];
  const container = field("container"), pid = Number(field("pid")), start = field("start"), boot = field("boot");
  return container && Number.isInteger(pid) && pid > 0 && start && boot ? { container, pid, start, boot } : null;
}

/** The process start time from /proc/<pid>/stat (field 22, after the parenthesised name). */
function startTime(stat: string): string | null {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
}

/** The real probe: the container id from mountinfo, the process start time from /proc, the kernel boot id. */
export const procProbe: ProcessProbe = {
  async self() {
    try {
      const [mountinfo, stat, boot] = await Promise.all([
        readFile("/proc/self/mountinfo", "utf8"),
        readFile("/proc/self/stat", "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const container = /\/containers\/([0-9a-f]{64})\//.exec(mountinfo)?.[1];
      const start = startTime(stat);
      return container && start ? { container, pid: process.pid, start, boot: boot.trim() } : null;
    } catch {
      return null;
    }
  },
  async alive(pid, start) {
    try {
      return startTime(await readFile(`/proc/${pid}/stat`, "utf8")) === start;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
    }
  },
};

export function createHeavyLock(options: HeavyLockOptions): HeavyLock {
  const { dir, owner, pollMs = 30_000, refreshMs = 4 * 60_000, cooldownMs = 60_000, probe = procProbe } = options;
  const log = options.log ?? ((message) => console.log(message));
  const now = options.now ?? (() => new Date());
  const ownerFile = path.join(dir, "owner.txt");
  let releasedAt = 0;
  let me: Promise<Holder | null> | undefined;
  const self = () => (me ??= probe.self());

  const line = async (label: string, token: string) => {
    const id = await self();
    const identity = id ? ` container=${id.container} pid=${id.pid} start=${id.start} boot=${id.boot}` : "";
    return `${owner} ${now().toISOString()} ${label}${identity} #${token}\n`;
  };
  const ours = async (token: string) => (await readFile(ownerFile, "utf8").catch(() => "")).includes(`#${token}`);

  /**
   * Proof that `holder` (an owner.txt line) is a dead process of ours: our owner, this container, and either
   * another kernel boot or a process that is gone. Anything unreadable or unprovable is not proof.
   */
  const provablyDead = async (holder: string): Promise<boolean> => {
    if (!holder.startsWith(`${owner} `)) return false;
    const [them, us] = [parseHolder(holder), await self()];
    if (!them || !us || them.container !== us.container) return false;
    if (them.pid === us.pid && them.start === us.start) return false; // that is this very process
    if (them.boot !== us.boot) return true; // the kernel restarted: every process of that boot is gone
    return (await probe.alive(them.pid, them.start)) === false;
  };

  /** Removes the lock if it still holds exactly `holder`: rename (atomic), check, and put it back on a mismatch. */
  const removeDead = async (holder: string): Promise<boolean> => {
    const cleanup = `${dir}.cleanup`;
    try {
      await mkdir(cleanup);
    } catch {
      return false; // another of our cleaners is at it
    }
    try {
      const tomb = `${dir}.dead-${randomUUID()}`;
      try {
        await rename(dir, tomb);
      } catch {
        return false; // gone already, or not ours to move
      }
      const moved = (await readFile(path.join(tomb, "owner.txt"), "utf8").catch(() => "")).trim();
      if (moved !== holder) {
        // Between the judgement and the rename someone else took the lock: give it back.
        await rename(tomb, dir).catch(() => log(`heavy-lock: moved a live lock aside by mistake and could not put it back (${tomb})`));
        return false;
      }
      await rm(tomb, { recursive: true, force: true });
      return true;
    } finally {
      await rmdir(cleanup).catch(() => undefined);
    }
  };

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
        const holder = (await readFile(ownerFile, "utf8").catch(() => "")).trim();
        if (holder && (await provablyDead(holder)) && (await removeDead(holder))) {
          log(`heavy-lock: removed the lock a dead process of this container left (${holder})`);
          continue;
        }
        if (waitingSince === undefined) {
          waitingSince = Date.now();
          log(`heavy-lock: ${label} waiting for ${dir}, held by ${holder || "(no owner.txt yet)"}`);
        }
        await wait(pollMs, signal);
      }

      // owner.txt is written and read back in the same step as the mkdir, so the lock is never ownerless.
      const token = randomUUID();
      try {
        await writeFile(ownerFile, await line(label, token));
        if (!(await ours(token))) throw new Error("owner.txt did not read back");
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw new Error(`heavy-lock: could not write ${ownerFile}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (waitingSince !== undefined) log(`heavy-lock: ${label} took the lock after ${Math.round((Date.now() - waitingSince) / 1000)}s`);

      // A refresh in flight is awaited before releasing: a read during its write sees an empty owner.txt.
      let refreshing: Promise<unknown> = Promise.resolve();
      const refresh = setInterval(() => {
        refreshing = ours(token).then(async (still) => (still ? writeFile(ownerFile, await line(label, token)) : undefined)).catch(() => undefined);
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
