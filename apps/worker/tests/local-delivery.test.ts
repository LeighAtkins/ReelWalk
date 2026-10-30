import { describe, expect, it, vi } from "vitest";
import type { Delivery, Outcome } from "../src/handler";
import type { HeavyLock } from "../src/heavy-lock";
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
