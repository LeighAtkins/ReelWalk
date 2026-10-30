import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { checkHeavyLockDir, createHeavyLock, parseHolder, type Holder, type ProcessProbe } from "../src/heavy-lock";

let root: string;
let dir: string;
const exists = (p: string) => stat(p).then(() => true, () => false);
const quiet = () => undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "heavy-lock-"));
  dir = path.join(root, ".heavy.lock");
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("heavy lock", () => {
  it("takes the lock with an owner.txt naming the holder, and removes it on release", async () => {
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", cooldownMs: 0, log: quiet });
    const release = await lock.acquire("render job-1");
    expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toMatch(/^reelwalk-local-worker \d{4}-\d\d-\d\dT[\d:.]+Z render job-1( container=\S+ pid=\d+ start=\S+ boot=\S+)? #[0-9a-f-]+\n$/);
    await release();
    expect(await exists(dir)).toBe(false);
    await release(); // idempotent
  });

  it("waits while someone else holds it, however old their owner.txt, and takes it once they let go", async () => {
    await mkdir(dir);
    await writeFile(path.join(dir, "owner.txt"), "lastmile-capture 2020-01-01T00:00:00Z\n");
    const messages: string[] = [];
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", pollMs: 20, cooldownMs: 0, log: (m) => messages.push(m) });
    let taken = false;
    const pending = lock.acquire("render job-2").then((release) => { taken = true; return release; });
    await sleep(120);
    expect(taken).toBe(false);
    expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toContain("lastmile-capture");
    expect(messages[0]).toContain("held by lastmile-capture");
    await rm(dir, { recursive: true });
    const release = await pending;
    expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toContain("render job-2");
    await release();
  });

  it("stops waiting when the attempt is stopped", async () => {
    await mkdir(dir);
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", pollMs: 20, cooldownMs: 0, log: quiet });
    const controller = new AbortController();
    const pending = lock.acquire("render job-3", controller.signal);
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    expect(await exists(dir)).toBe(true); // still the other holder's
  });

  it("never removes a lock that is no longer ours", async () => {
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", cooldownMs: 0, log: quiet });
    const release = await lock.acquire("render job-4");
    // Someone removed ours by hand and took it themselves.
    await rm(dir, { recursive: true });
    await mkdir(dir);
    await writeFile(path.join(dir, "owner.txt"), "lastmile-build now\n");
    await release();
    expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toBe("lastmile-build now\n");
  });

  it("rewrites owner.txt while held", async () => {
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", refreshMs: 30, cooldownMs: 0, log: quiet });
    const release = await lock.acquire("render job-5");
    const first = await readFile(path.join(dir, "owner.txt"), "utf8");
    let later = first;
    for (let i = 0; i < 50 && (later === first || !later.endsWith("\n")); i++) {
      await sleep(10);
      later = await readFile(path.join(dir, "owner.txt"), "utf8");
    }
    expect(later).not.toBe(first);
    expect(later.split("#")[1]).toBe(first.split("#")[1]);
    await release();
  });

  it("gives the other side a turn before taking it again", async () => {
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", cooldownMs: 150, log: quiet });
    await (await lock.acquire("render a"))();
    const started = Date.now();
    await (await lock.acquire("render b"))();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  // Identity and liveness as seen from inside the worker's container, stood in for here.
  const C = "a".repeat(64), OTHER = "b".repeat(64);
  const line = (container: string, pid: number, start: string, boot: string) =>
    `reelwalk-local-worker 2026-10-29T15:00:00.000Z render old-job container=${container} pid=${pid} start=${start} boot=${boot} #t`;
  function probe(alive: (pid: number, start: string) => boolean | null, self: Holder | null = { container: C, pid: 1, start: "500", boot: "k1" }): ProcessProbe {
    return { self: async () => self, alive: async (pid, start) => alive(pid, start) };
  }
  async function holding(holder: string) {
    await mkdir(dir);
    await writeFile(path.join(dir, "owner.txt"), `${holder}\n`);
  }
  /** Tries for the lock briefly; true if taken (then released), false if it kept waiting. */
  async function tryTake(p: ProcessProbe, ms = 150) {
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", pollMs: 20, cooldownMs: 0, log: quiet, probe: p });
    try {
      await (await lock.acquire("render new-job", AbortSignal.timeout(ms)))();
      return true;
    } catch {
      return false;
    }
  }
  const lockText = () => readFile(path.join(dir, "owner.txt"), "utf8").then((text) => text.trim(), () => null);

  it("names the container, process, start time and kernel boot in owner.txt", async () => {
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", cooldownMs: 0, log: quiet, probe: probe(() => true) });
    const release = await lock.acquire("render job-6");
    expect(parseHolder(await readFile(path.join(dir, "owner.txt"), "utf8"))).toEqual({ container: C, pid: 1, start: "500", boot: "k1" });
    await release();
  });

  it("never removes a live holder in the same container (another process, reproduced in review)", async () => {
    await holding(line(C, 42, "900", "k1"));
    expect(await tryTake(probe((pid, start) => pid === 42 && start === "900"))).toBe(false);
    expect(await lockText()).toBe(line(C, 42, "900", "k1"));
  });

  it("removes a lock whose process provably died: gone from this container, its PID reused, or another kernel boot", async () => {
    for (const [holder, alive] of [
      [line(C, 42, "900", "k1"), () => false], // no such process any more
      [line(C, 42, "900", "k1"), (_pid: number, start: string) => start === "1234"], // PID 42 now belongs to a newer process
      [line(C, 42, "900", "k0"), () => true], // written before the kernel last booted
    ] as const) {
      await holding(holder);
      expect(await tryTake(probe(alive))).toBe(true);
      expect(await lockText()).toBeNull();
    }
  });

  it("fails closed: an unreadable process, another container, another owner, or no identity of its own leaves the lock", async () => {
    for (const [holder, p] of [
      [line(C, 42, "900", "k1"), probe(() => null)], // cannot tell
      [line(OTHER, 42, "900", "k0"), probe(() => false)], // not this container: its processes are not visible here
      ["lastmile-capture 2026-10-29T15:00:00Z container=" + C + " pid=42 start=900 boot=k0", probe(() => false)],
      ["reelwalk-local-worker 2026-10-29T15:00:00Z render old-job #t", probe(() => false)], // no identity recorded
      [line(C, 42, "900", "k0"), probe(() => false, null)], // this worker cannot see who it is (not in a container)
    ] as const) {
      await holding(holder);
      expect(await tryTake(p, 100)).toBe(false);
      expect(await lockText()).toBe(holder);
      await rm(dir, { recursive: true });
    }
  });

  it("puts the lock back when someone else took it between the judgement and the removal", async () => {
    const dead = line(C, 42, "900", "k1");
    const newcomer = "lastmile-capture 2026-10-30T00:00:00Z godot";
    await holding(dead);
    // While this worker judges the dead holder, the lock changes hands (another cleaner removed it and a live job took it).
    const racing = probe(() => {
      fs.rmSync(dir, { recursive: true });
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "owner.txt"), newcomer + "\n");
      return false;
    });
    expect(await tryTake(racing, 60)).toBe(false);
    expect(await lockText()).toBe(newcomer);
  });

  it("leaves the cleanup to another of our cleaners already at it", async () => {
    await holding(line(C, 42, "900", "k1"));
    await mkdir(`${dir}.cleanup`);
    expect(await tryTake(probe(() => false), 100)).toBe(false);
    expect(await lockText()).toBe(line(C, 42, "900", "k1"));
    await rm(`${dir}.cleanup`, { recursive: true });
  });

  it("refuses a lock directory whose parent is missing", async () => {
    await expect(checkHeavyLockDir(path.join(root, "missing", ".heavy.lock"))).rejects.toThrow(/not a directory/);
    await expect(checkHeavyLockDir(dir)).resolves.toBeUndefined();
    const lock = createHeavyLock({ dir: path.join(root, "missing", ".heavy.lock"), owner: "x", cooldownMs: 0, log: quiet });
    await expect(lock.acquire("render")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
