import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot, RenderJobMessage } from "@reelwalk/core";
import { handleDelivery, settleRedundant, type ClaimedJob, type Delivery, type JobStore, type Outcome } from "../src/handler";
import { createHeavyLock, type HeavyLock } from "../src/heavy-lock";
import { handleLocalDelivery, type LocalDeliveryDeps } from "../src/local-delivery";

const body = JSON.stringify({ jobId: "job-1", generation: 2 });

function delivery(): Delivery & { handBack: ReturnType<typeof vi.fn> } {
  return { body, receiveCount: 1, extend: vi.fn(async () => {}), delete: vi.fn(async () => {}), handBack: vi.fn(async () => {}) };
}

/** A lock that is free, or held by someone else until the waiter gives up. */
function lock(state: "free" | "held", events: string[] = []): HeavyLock {
  return {
    acquire: (_label, signal) =>
      state === "free"
        ? Promise.resolve(async () => void events.push("released"))
        : new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
  };
}

function deps(overrides: Partial<LocalDeliveryDeps>): LocalDeliveryDeps & { handOff: ReturnType<typeof vi.fn>; handle: ReturnType<typeof vi.fn> } {
  return {
    lock: lock("free"),
    waitMs: 60,
    keepHiddenMs: 10,
    visibilitySeconds: 120,
    handOff: vi.fn(async () => true),
    handle: vi.fn(async (): Promise<Outcome> => "succeeded"),
    log: () => undefined,
    ...overrides,
  } as never;
}

describe("a local worker's delivery", () => {
  it("claims and renders inside the heavy lock, and releases it after the handler", async () => {
    const events: string[] = [];
    const d = deps({ lock: lock("free", events), handle: vi.fn(async () => (events.push("handled"), "succeeded" as const)) });
    expect(await handleLocalDelivery(d, delivery())).toBe("succeeded");
    expect(events).toEqual(["handled", "released"]);
    expect(d.handOff).not.toHaveBeenCalled();
  });

  it("hands an unclaimed job to the cloud when the lock is not free in time, without claiming it", async () => {
    const d = deps({ lock: lock("held") });
    const message = delivery();
    expect(await handleLocalDelivery(d, message)).toBe("handed-off");
    // Never claimed (the handler never ran), so no attempt is spent; the local message goes.
    expect(d.handle).not.toHaveBeenCalled();
    expect(d.handOff).toHaveBeenCalledWith({ jobId: "job-1", generation: 2 });
    expect(message.delete).toHaveBeenCalled();
    // Kept hidden while it waited, so no other receive counted against it.
    expect(message.extend).toHaveBeenCalledWith(120);
  });

  it("just drops the message when the job has moved on already", async () => {
    const d = deps({ lock: lock("held"), handOff: vi.fn(async () => false) });
    const message = delivery();
    expect(await handleLocalDelivery(d, message)).toBe("discarded");
    expect(message.delete).toHaveBeenCalled();
  });

  it("hands the message back to its queue when the worker stops while waiting", async () => {
    const shutdown = new AbortController();
    const d = deps({ lock: lock("held"), waitMs: 60_000, shutdown: shutdown.signal });
    const message = delivery();
    const outcome = handleLocalDelivery(d, message);
    shutdown.abort();
    expect(await outcome).toBe("interrupted");
    expect(message.handBack).toHaveBeenCalled();
    expect(d.handOff).not.toHaveBeenCalled();
    expect(d.handle).not.toHaveBeenCalled();
  });
});

describe("a local worker's allowlist (ADR 0094)", () => {
  it("hands a job of a workspace it may not write for to the cloud at once, without waiting or claiming", async () => {
    const d = deps({ lock: lock("held"), waitMs: 60_000, allowed: vi.fn(async () => false) });
    const message = delivery();
    expect(await handleLocalDelivery(d, message)).toBe("handed-off");
    expect(d.handOff).toHaveBeenCalledWith({ jobId: "job-1", generation: 2 });
    expect(d.handle).not.toHaveBeenCalled();
    expect(message.delete).toHaveBeenCalled();
  });

  it("renders a job of one of its workspaces", async () => {
    const d = deps({ allowed: vi.fn(async () => true) });
    expect(await handleLocalDelivery(d, delivery())).toBe("succeeded");
    expect(d.handOff).not.toHaveBeenCalled();
  });
});

/** A job store over one in-memory row per job: snapshot and claim read the same row, so a test can change it between them. */
function memoryStore(rows: Map<string, JobSnapshot>): JobStore {
  return {
    snapshot: async (jobId) => rows.get(jobId) ?? null,
    claim: async (message: RenderJobMessage): Promise<ClaimedJob | null> => {
      const row = rows.get(message.jobId);
      if (!row || row.generation !== message.generation || row.status !== "QUEUED") return null;
      rows.set(message.jobId, { ...row, status: "RUNNING", heartbeatAt: new Date() });
      return { id: message.jobId, workspaceId: "ws", generation: row.generation, attempt: 1, kind: "REEL", caption: null, payload: {}, inputKey: null, brand: null };
    },
    heartbeat: async () => true,
    succeed: async (lease) => (rows.set(lease.jobId, { ...rows.get(lease.jobId)!, status: "SUCCEEDED" }), true),
    requeue: async () => {},
    interrupt: async () => {},
    fail: async () => {},
    failAbandoned: async () => {},
  };
}

const config = { maxAttempts: 3, visibilitySeconds: 120, heartbeatSeconds: 60, staleSeconds: 300, retryBackoffSeconds: 1 };
const output = { objectKey: "out.mp4", contentType: "video/mp4", sizeBytes: 1 };

describe("a local worker's stale messages (ADR 0094)", () => {
  let root: string;
  beforeEach(async () => {
    // Never the real shared lock: every lock here lives in a temp directory.
    root = await mkdtemp(path.join(os.tmpdir(), "local-delivery-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  /** The worker's wiring (index.ts) over a memory store and a real heavy lock in the temp directory. */
  function wire(rows: Map<string, JobSnapshot>, cooldownMs: number) {
    const store = memoryStore(rows);
    const real = createHeavyLock({ dir: path.join(root, ".heavy.lock"), owner: "reelwalk-local-worker", pollMs: 10, cooldownMs, log: () => undefined });
    const lock = { acquire: vi.fn(real.acquire) };
    const render = vi.fn(async () => output);
    const claimedAt: number[] = [];
    const local: LocalDeliveryDeps = {
      lock,
      waitMs: 10_000,
      keepHiddenMs: 1000,
      visibilitySeconds: 120,
      handOff: vi.fn(async () => false),
      settle: (received, message) => settleRedundant({ store, config, log: () => undefined }, received, message),
      handle: (received, onClaimed) =>
        handleDelivery({ store, config, render, onClaimed: () => (claimedAt.push(Date.now()), onClaimed()), log: () => undefined }, received),
      log: () => undefined,
    };
    return { local, lock, real, render, claimedAt };
  }
  const deliveryOf = (jobId: string, generation: number) =>
    ({ body: JSON.stringify({ jobId, generation }), receiveCount: 1, extend: vi.fn(async () => {}), delete: vi.fn(async () => {}) }) satisfies Delivery;
  const queued = (): JobSnapshot => ({ status: "QUEUED", generation: 1, heartbeatAt: null });

  it("clears a backlog of messages whose jobs moved on without taking the lock or waiting out a cooldown", async () => {
    // Seven jobs that fell back to the cloud (a new generation) and succeeded there.
    const rows = new Map(Array.from({ length: 7 }, (_, i): [string, JobSnapshot] => [`job-${i}`, { status: "SUCCEEDED", generation: 2, heartbeatAt: null }]));
    const { local, lock, render } = wire(rows, 60_000);
    const started = Date.now();
    for (let i = 0; i < 7; i++) {
      const message = deliveryOf(`job-${i}`, 1);
      expect(await handleLocalDelivery(local, message)).toBe("discarded");
      expect(message.delete).toHaveBeenCalled();
    }
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still takes the lock for a real render, and gives the other side its cooldown after it", async () => {
    const rows = new Map([["a", queued()], ["b", queued()]]);
    const { local, lock, render, claimedAt } = wire(rows, 400);
    expect(await handleLocalDelivery(local, deliveryOf("a", 1))).toBe("succeeded");
    const releasedAt = Date.now();
    expect(await handleLocalDelivery(local, deliveryOf("b", 1))).toBe("succeeded");
    expect(lock.acquire).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);
    expect(claimedAt[1]! - releasedAt).toBeGreaterThanOrEqual(350);
  });

  it("never renders a job that goes stale between the read and the claim, and spends no cooldown on it", async () => {
    const rows = new Map([["a", queued()], ["b", queued()]]);
    const { local, lock, real, render, claimedAt } = wire(rows, 60_000);
    // The read sees a QUEUED job; while the worker waits for the lock, the fallback moves it to the cloud.
    lock.acquire.mockImplementationOnce(async (label, signal) => {
      rows.set("a", { status: "QUEUED", generation: 2, heartbeatAt: null });
      return real.acquire(label, signal);
    });
    const message = deliveryOf("a", 1);
    expect(await handleLocalDelivery(local, message)).toBe("discarded");
    expect(message.delete).toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    // That hold rendered nothing, so the next real job does not wait out the 60 s cooldown.
    const started = Date.now();
    expect(await handleLocalDelivery(local, deliveryOf("b", 1))).toBe("succeeded");
    expect(claimedAt).toHaveLength(1);
    expect(claimedAt[0]! - started).toBeLessThan(1000);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
