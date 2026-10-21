import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The life of one render attempt (ADR 0050). Everything an attempt starts
 * that can outlive a rejected promise (headless Chrome, ffmpeg, an upload,
 * a temp dir) is either cancelled through the attempt's AbortSignal or
 * registered with its scope, and the scope is closed before the attempt is
 * reported. The job deadline, a tool's own timeout and SIGTERM all end in
 * the same place: the signal aborts, the work gets a short grace to unwind
 * through its own `finally` blocks, then whatever is still held is released
 * by force (SIGKILL for processes).
 */

/** How long aborted work may take to unwind before its resources are released by force. */
export const DEFAULT_GRACE_MS = 10_000;

export type StopReason = "deadline" | "shutdown" | "cancelled";

/** Why an attempt was stopped from outside. The handler reads `why` to decide between a retry and a hand-back. */
export class AttemptStopped extends Error {
  constructor(message: string, readonly why: StopReason) {
    super(message);
    this.name = "AttemptStopped";
  }
}

type Log = (message: string, error?: unknown) => void;

export interface AttemptScope {
  /** Aborted when the attempt is stopped; its `reason` is an AttemptStopped. Pass it to every long step. */
  readonly signal: AbortSignal;
  /** How long aborted work gets to unwind, and how long closing the scope (all releases together) may take. */
  readonly graceMs: number;
  abort(reason: AttemptStopped): void;
  /** Throws the stop reason if the attempt was stopped: for steps that swallow their own errors. */
  throwIfStopped(): void;
  /**
   * Registers something to release when the attempt ends, however it ends.
   * Returns a function that forgets it (call it once the resource is gone on
   * its own). Registered after the scope closed, it is released at once.
   * `release` is told how many ms are left of the close budget.
   */
  own(name: string, release: (remainingMs: number) => unknown): () => void;
  /** A fresh temp dir owned by the attempt. */
  tempDir(prefix: string): Promise<string>;
  /** Names of what is still held, oldest first. */
  held(): string[];
  /**
   * Releases everything held, newest first, all within one budget of
   * `graceMs`. Releases still waiting when the budget runs out are started
   * without waiting for them (so each still sends its kill), and close
   * returns. Idempotent.
   */
  close(): Promise<void>;
}

function delay(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

export function createAttemptScope(options: { graceMs?: number; log?: Log } = {}): AttemptScope {
  const controller = new AbortController();
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const log: Log = options.log ?? ((message, error) => console.warn(message, error ?? ""));
  const resources = new Map<number, { name: string; release: (remainingMs: number) => unknown }>();
  let nextId = 0;
  let closing: Promise<void> | null = null;

  async function release(name: string, fn: (remainingMs: number) => unknown, ms: number) {
    const timer = delay(ms);
    try {
      const result = await Promise.race([Promise.resolve(ms).then(fn).then(() => "done" as const), timer.promise]);
      if (result === "timeout") log(`release of ${name} did not finish within the ${ms} ms left; moving on`);
    } catch (error) {
      log(`release of ${name} failed`, error);
    } finally {
      timer.cancel();
    }
  }

  const scope: AttemptScope = {
    signal: controller.signal,
    graceMs,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    throwIfStopped() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    own(name, fn) {
      if (closing) {
        void release(name, fn, graceMs);
        return () => {};
      }
      const id = nextId++;
      resources.set(id, { name, release: fn });
      return () => { resources.delete(id); };
    },
    async tempDir(prefix) {
      const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
      scope.own(`temp dir ${dir}`, () => rm(dir, { recursive: true, force: true }));
      return dir;
    },
    held() {
      return [...resources.values()].map((resource) => resource.name);
    },
    close() {
      closing ??= (async () => {
        // One budget for the whole close, so the time from stop to report stays bounded however much is held.
        const deadline = Date.now() + graceMs;
        // Newest first: a process writing into a temp dir is stopped before the dir goes.
        while (resources.size > 0) {
          const id = [...resources.keys()].pop()!;
          const { name, release: fn } = resources.get(id)!;
          resources.delete(id);
          const remaining = deadline - Date.now();
          if (remaining > 0) await release(name, fn, remaining);
          else void release(name, fn, 0);
        }
      })();
      return closing;
    },
  };
  return scope;
}

/**
 * Runs an attempt's work inside its scope and settles only once the scope is
 * closed. If the scope is aborted first, the work gets `graceMs` to unwind,
 * then everything it still holds is released and the stop reason is thrown,
 * whether or not the work ever settles.
 */
export async function runAttempt<T>(scope: AttemptScope, work: () => Promise<T>): Promise<T> {
  const settled = Promise.resolve()
    .then(work)
    .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  let onAbort: () => void = () => {};
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    if (scope.signal.aborted) onAbort();
    else scope.signal.addEventListener("abort", onAbort, { once: true });
  });
  const first = await Promise.race([settled, aborted]);
  scope.signal.removeEventListener("abort", onAbort);

  if (first === "aborted") {
    const grace = delay(scope.graceMs);
    const late = await Promise.race([settled, grace.promise]);
    grace.cancel();
    await scope.close();
    // Work that finished during the grace finished: its result stands.
    if (late !== "timeout" && late.ok) return late.value;
    throw scope.signal.reason;
  }
  await scope.close();
  if (first.ok) return first.value;
  // Work that failed because it was stopped reports why it was stopped, not the cancellation error it saw.
  throw scope.signal.aborted ? scope.signal.reason : first.error;
}

/**
 * Aborts the scope when `source` aborts (SIGTERM, a parent's cancel), after
 * `delayMs` (a drain window in which the work may still finish). Returns the
 * unlink, which also cancels a pending delayed abort.
 */
export function linkAbort(source: AbortSignal | undefined, scope: AttemptScope, reason: () => AttemptStopped, delayMs = 0): () => void {
  if (!source) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    if (delayMs > 0) timer = setTimeout(() => scope.abort(reason()), delayMs);
    else scope.abort(reason());
  };
  if (source.aborted) onAbort();
  else source.addEventListener("abort", onAbort, { once: true });
  return () => {
    source.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  };
}

/** Aborts the scope after `ms`. Returns the cancel. */
export function abortAfter(scope: AttemptScope, ms: number, reason: () => AttemptStopped): () => void {
  const timer = setTimeout(() => scope.abort(reason()), ms);
  return () => clearTimeout(timer);
}

// ── Child processes ─────────────────────────────────────────────

/** Spawn children in their own process group on POSIX, so the whole group can be killed. */
export const OWN_PROCESS_GROUP = process.platform !== "win32";

function running(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/** Signals a child and, when it leads its own process group, everything it started. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!running(child)) return;
  if (OWN_PROCESS_GROUP) {
    try {
      process.kill(-child.pid!, signal);
      return;
    } catch {
      // Not a group leader (spawned without `detached`): fall back to the process alone.
    }
  }
  child.kill(signal);
}

/** Resolves true once the child has exited, false if it is still running after `ms`. */
export function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (!running(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, ms);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once("exit", onExit);
  });
}

/** Registers a child with the scope: on release its group is SIGKILLed and its exit awaited (within the close budget). */
export function ownChild(scope: AttemptScope, child: ChildProcess, name: string): () => void {
  return scope.own(`${name} (pid ${child.pid})`, async (remainingMs) => {
    killTree(child, "SIGKILL");
    await exited(child, remainingMs);
  });
}

// ── Processes another library spawned ───────────────────────────

/** `state` is the kernel's one-letter state; "Z" is a zombie: exited, holding nothing but its pid until reaped. */
type ProcInfo = { pid: number; ppid: number; state: string; command: string };

/** Every process on a Linux /proc, with its parent and its argv[0] (or comm). Empty elsewhere. */
export async function listProcesses(procRoot = "/proc"): Promise<ProcInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  const out: ProcInfo[] = [];
  await Promise.all(
    entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
      try {
        const stat = await readFile(path.join(procRoot, entry, "stat"), "utf8");
        // "pid (comm) state ppid ...": comm may contain spaces and parens, so split at the last ')'.
        const close = stat.lastIndexOf(")");
        const comm = stat.slice(stat.indexOf("(") + 1, close);
        const [state, ppid] = stat.slice(close + 2).split(" ");
        const cmdline = await readFile(path.join(procRoot, entry, "cmdline"), "utf8").catch(() => "");
        out.push({ pid: Number(entry), ppid: Number(ppid), state, command: cmdline.split("\0")[0] || comm });
      } catch {
        // Exited while we looked.
      }
    }),
  );
  return out.sort((a, b) => a.pid - b.pid);
}

/** Descendants of `root` (not `root` itself), parents before children. */
export function descendantsOf(root: number, processes: ProcInfo[]): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const proc of processes) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc]);
  const out: ProcInfo[] = [];
  const queue = [root];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** Whether a process still runs. A zombie counts as gone: signal 0 reaches it, but it holds nothing. */
async function pidRunning(pid: number, procRoot: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = await readFile(path.join(procRoot, String(pid), "stat"), "utf8").catch(() => null);
  return stat !== null && stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
}

/** Processes Remotion starts: headless Chrome and its helpers, the compositor and its ffmpeg. */
export const REMOTION_PROCESSES = /chrome|headless_shell|remotion/i;

/**
 * The backstop for processes a library spawned and closes without waiting
 * (Remotion closes its Chrome fire-and-forget when a render is cancelled).
 * Finds this process's descendants whose command matches, SIGTERMs the whole
 * set at once (collected first, so children are not orphaned out of reach),
 * waits up to half of `graceMs`, then SIGKILLs what is left and waits the
 * other half for it to go, so the SIGKILL lands inside a release bounded by
 * the same grace. Linux only; a no-op where there is no /proc. Returns the
 * pids it signalled.
 */
export async function killDescendants(options: { match: RegExp; graceMs: number; root?: number; procRoot?: string }): Promise<number[]> {
  const procRoot = options.procRoot ?? "/proc";
  const targets = descendantsOf(options.root ?? process.pid, await listProcesses(procRoot))
    .filter((proc) => proc.state !== "Z" && options.match.test(proc.command))
    .map((proc) => proc.pid);
  const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name); } catch { /* gone */ } };
  const left = async () => {
    const states = await Promise.all(targets.map((pid) => pidRunning(pid, procRoot)));
    return targets.filter((_, index) => states[index]);
  };
  const waitGone = async (ms: number) => {
    const until = Date.now() + ms;
    while ((await left()).length > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  };
  for (const pid of targets) signal(pid, "SIGTERM");
  await waitGone(options.graceMs / 2);
  for (const pid of await left()) signal(pid, "SIGKILL");
  await waitGone(options.graceMs / 2);
  return targets;
}
