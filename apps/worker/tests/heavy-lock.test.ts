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
    expect(await readFile(path.join(dir, "owner.txt"), "utf8")).toMatch(/^reelwalk-local-worker \d{4}-\d\d-\d\dT[\d:.]+Z render job-1 #[0-9a-f-]+\n$/);
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

  it("refuses a lock directory whose parent is missing", async () => {
    await expect(checkHeavyLockDir(path.join(root, "missing", ".heavy.lock"))).rejects.toThrow(/not a directory/);
    await expect(checkHeavyLockDir(dir)).resolves.toBeUndefined();
    const lock = createHeavyLock({ dir: path.join(root, "missing", ".heavy.lock"), owner: "x", cooldownMs: 0, log: quiet });
    await expect(lock.acquire("render")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
