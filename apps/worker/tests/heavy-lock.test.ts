import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHeavyLockDir, createHeavyLock } from "../src/heavy-lock";

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
    expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toMatch(/^reelwalk-local-worker \d{4}-\d\d-\d\dT[\d:.]+Z render job-1 host=\S+ boot=\S+ #[0-9a-f-]+\n$/);
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

  it("names the container and process in owner.txt", async () => {
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", cooldownMs: 0, log: quiet, host: "c0ffee", boot: "b1" });
    const release = await lock.acquire("render job-6");
    expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toMatch(/ render job-6 host=c0ffee boot=b1 #/);
    await release();
  });

  it("removes a lock this container's previous process left when it died, and takes it", async () => {
    await mkdir(dir);
    await writeFile(path.join(dir, "owner.txt"), "reelwalk-local-worker 2026-10-29T15:00:00.000Z render job-7 host=c0ffee boot=dead #t\n");
    const messages: string[] = [];
    const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", pollMs: 20, cooldownMs: 0, log: (m) => messages.push(m), host: "c0ffee", boot: "b2" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("still waiting")), 500);
    const release = await lock.acquire("render job-8", controller.signal);
    clearTimeout(timer);
    expect(messages.some((m) => m.includes("previous process left"))).toBe(true);
    expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toContain("render job-8 host=c0ffee boot=b2");
    await release();
  });

  it("never removes a lock another container, or another owner, holds", async () => {
    for (const holder of [
      "reelwalk-local-worker 2026-10-29T15:00:00.000Z render job-9 host=beef01 boot=dead #t\n",
      "lastmile-capture 2026-10-29T15:00:00.000Z host=c0ffee boot=dead\n",
    ]) {
      await mkdir(dir);
      await writeFile(path.join(dir, "owner.txt"), holder);
      const lock = createHeavyLock({ dir, owner: "reelwalk-local-worker", pollMs: 20, cooldownMs: 0, log: quiet, host: "c0ffee", boot: "b3" });
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("gave up")), 120);
      await expect(lock.acquire("render job-10", controller.signal)).rejects.toThrow("gave up");
      expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toBe(holder);
      await rm(dir, { recursive: true });
    }
  });

  it("refuses a lock directory whose parent is missing", async () => {
    await expect(checkHeavyLockDir(path.join(root, "missing", ".heavy.lock"))).rejects.toThrow(/not a directory/);
    await expect(checkHeavyLockDir(dir)).resolves.toBeUndefined();
    const lock = createHeavyLock({ dir: path.join(root, "missing", ".heavy.lock"), owner: "x", cooldownMs: 0, log: quiet });
    await expect(lock.acquire("render")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
