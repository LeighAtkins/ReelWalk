import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { outputKeyFor, type JobSnapshot } from "@reelwalk/core";
import { handleDelivery, type Delivery, type HandlerDeps, type JobStore, type Lease } from "../src/handler";
import { AttemptStopped, OWN_PROCESS_GROUP, ownChild, type AttemptScope } from "../src/lifecycle";

// ADR 0050: a stopped attempt releases what it holds before it is reported.

const config = { maxAttempts: 3, visibilitySeconds: 120, heartbeatSeconds: 20, staleSeconds: 60, retryBackoffSeconds: 15, abortGraceSeconds: 0.2 };
const output = { objectKey: "renders/job-1-1.mp4", contentType: "video/mp4", sizeBytes: 1234 };
const queued: JobSnapshot = { status: "QUEUED", generation: 1, heartbeatAt: null };

/** A job store whose writes append to `events`, so a test can see what happened before the lease was given up. */
function recordingStore(events: string[]) {
  const state = { job: { ...queued } as JobSnapshot, attempt: 0, error: null as string | null };
  const mine = (lease: Lease) => state.job.generation === lease.generation && state.attempt === lease.attempt && state.job.status === "RUNNING";
  const store: JobStore = {
    snapshot: async () => ({ ...state.job }),
    claim: async (message) => {
      if (state.job.status !== "QUEUED") return null;
      state.job.status = "RUNNING";
      const attempt = ++state.attempt;
      return { id: message.jobId, generation: message.generation, attempt, kind: "REEL", caption: null, payload: null, inputKey: null, brand: null };
    },
    heartbeat: async () => true,
    succeed: async (lease) => {
      events.push("succeed");
      if (!mine(lease)) return false;
      state.job.status = "SUCCEEDED";
      return true;
    },
    requeue: async (lease, error) => {
      events.push("requeue");
      if (!mine(lease)) return;
      state.error = error;
      state.job.status = "QUEUED";
    },
    // A shutdown's requeue; recorded as one so the ordering checks below cover both.
    interrupt: async (lease, error) => store.requeue(lease, error),
    fail: async (lease, error) => {
      events.push("fail");
      if (!mine(lease)) return;
      state.error = error;
      state.job.status = "FAILED";
    },
    failAbandoned: async () => {},
  };
  return { store, state };
}

function recordingDelivery(events: string[], receiveCount = 1) {
  return {
    body: JSON.stringify({ jobId: "job-1", generation: 1 }),
    receiveCount,
    extend: vi.fn(async (seconds: number) => { events.push(`extend ${seconds}`); }),
    delete: vi.fn(async () => { events.push("delete"); }),
  } satisfies Delivery;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A process that would run for ever: stands in for ffmpeg or Chrome. */
function hangingChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: OWN_PROCESS_GROUP });
}

/**
 * A render that takes a fake browser, a real child process and a temp dir,
 * then hangs and ignores its abort signal: the worst case, where only the
 * scope can clean up. Records what it held and when each was released.
 */
function hangingRender(events: string[]) {
  const held: { child?: ChildProcess; dir?: string; scope?: AttemptScope; abortedAt?: number; reason?: unknown } = {};
  const render: HandlerDeps["render"] = async (_job, _progress, scope) => {
    held.scope = scope;
    scope.signal.addEventListener("abort", () => { held.abortedAt = Date.now(); held.reason = scope.signal.reason; });
    held.dir = await scope.tempDir("reelwalk-cancel-test-");
    scope.own("fake browser", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("browser closed");
    });
    held.child = hangingChild();
    const pid = held.child.pid!;
    held.child.once("exit", () => events.push("child exited"));
    ownChild(scope, held.child, "fake ffmpeg");
    events.push(`render started ${pid}`);
    return new Promise<typeof output>(() => undefined);
  };
  return { render, held };
}

describe("cancelling a render attempt", () => {
  it("aborts the attempt's signal at the job deadline", async () => {
    const events: string[] = [];
    const { store, state } = recordingStore(events);
    let reason: unknown;
    const started = Date.now();
    // A render that cooperates: it unwinds as soon as it is told to.
    const render: HandlerDeps["render"] = (_job, _progress, scope) =>
      new Promise((_, reject) => scope.signal.addEventListener("abort", () => { reason = scope.signal.reason; reject(new Error("cancelled")); }));

    const outcome = await handleDelivery({ store, render, config: { ...config, jobTimeoutSeconds: 0.15, abortGraceSeconds: 5 }, log: () => {} }, recordingDelivery(events));
    const took = Date.now() - started;

    expect(outcome).toBe("retrying");
    expect(reason).toBeInstanceOf(AttemptStopped);
    expect((reason as AttemptStopped).why).toBe("deadline");
    // Reported as the deadline, not as the cancellation error the render saw.
    expect(state.error).toMatch(/exceeded/);
    expect(state.job.status).toBe("QUEUED");
    // Fired at the deadline, and a render that unwinds promptly does not wait out the grace.
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(2000);
  });

  it("releases the browser, child process and temp dir before reporting a timed-out attempt", async () => {
    const events: string[] = [];
    const { store, state } = recordingStore(events);
    const { render, held } = hangingRender(events);
    const delivery = recordingDelivery(events);
    // Checked at the moment the lease is given up.
    let atRequeue: { childAlive: boolean; dirExists: boolean; held: string[] } | undefined;
    const requeue = store.requeue;
    store.requeue = async (lease, error) => {
      atRequeue = { childAlive: alive(held.child!.pid!), dirExists: existsSync(held.dir!), held: held.scope!.held() };
      return requeue(lease, error);
    };

    const outcome = await handleDelivery({ store, render, config: { ...config, jobTimeoutSeconds: 0.1 }, log: () => {} }, delivery);

    expect(outcome).toBe("retrying");
    expect(held.abortedAt).toBeDefined();
    expect((held.reason as AttemptStopped).why).toBe("deadline");
    expect(atRequeue).toEqual({ childAlive: false, dirExists: false, held: [] });
    const order = (name: string) => events.findIndex((event) => event.startsWith(name));
    expect(order("browser closed")).toBeGreaterThan(-1);
    expect(order("child exited")).toBeGreaterThan(-1);
    // The lease (requeue, then the visibility change that hands the message on) goes only after cleanup.
    expect(order("requeue")).toBeGreaterThan(order("browser closed"));
    expect(order("requeue")).toBeGreaterThan(order("child exited"));
    expect(events.map((event) => event.startsWith("extend")).lastIndexOf(true)).toBeGreaterThan(order("requeue"));
    expect(state.job.status).toBe("QUEUED");
    expect(delivery.delete).not.toHaveBeenCalled();
  });

  it("on SIGTERM releases everything and hands the job back for another worker", async () => {
    const events: string[] = [];
    const { store, state } = recordingStore(events);
    const { render, held } = hangingRender(events);
    const delivery = recordingDelivery(events, 2);
    const shutdown = new AbortController();

    const outcome = handleDelivery({ store, render, shutdown: shutdown.signal, config: { ...config, jobTimeoutSeconds: 60 }, log: () => {} }, delivery);
    await vi.waitFor(() => expect(events.some((event) => event.startsWith("render started"))).toBe(true));
    shutdown.abort();

    expect(await outcome).toBe("interrupted");
    expect((held.reason as AttemptStopped).why).toBe("shutdown");
    expect(alive(held.child!.pid!)).toBe(false);
    expect(existsSync(held.dir!)).toBe(false);
    expect(events.indexOf("requeue")).toBeGreaterThan(events.indexOf("browser closed"));
    expect(events.indexOf("requeue")).toBeGreaterThan(events.indexOf("child exited"));
    // Requeueable: QUEUED, and the message visible again at once (no backoff, not failed, not deleted).
    expect(state.job.status).toBe("QUEUED");
    expect(state.error).toMatch(/stopped/);
    expect(delivery.extend).toHaveBeenLastCalledWith(0);
    expect(delivery.delete).not.toHaveBeenCalled();
    expect(events).not.toContain("fail");
  });

  it("leaves a successful attempt alone, releasing what it held before publishing", async () => {
    const events: string[] = [];
    const { store, state } = recordingStore(events);
    const delivery = recordingDelivery(events);
    let signal: AbortSignal | undefined;
    let dir = "";
    const render: HandlerDeps["render"] = async (_job, progress, scope) => {
      signal = scope.signal;
      dir = await scope.tempDir("reelwalk-cancel-test-");
      scope.own("fake browser", () => { events.push("browser closed"); });
      progress(100);
      return output;
    };

    expect(await handleDelivery({ store, render, config: { ...config, jobTimeoutSeconds: 60 }, log: () => {} }, delivery)).toBe("succeeded");
    expect(signal!.aborted).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(events).toEqual(["browser closed", "succeed", "delete"]);
    expect(state.job.status).toBe("SUCCEEDED");
  });
});

describe("handing a job back on shutdown", () => {
  /** A delivery whose handBack queues a fresh message (receive count 1), as SQS SendMessage + DeleteMessage would. */
  function queue(events: string[]) {
    const fresh: Delivery[] = [];
    const make = (receiveCount: number): Delivery => ({
      body: JSON.stringify({ jobId: "job-1", generation: 1 }),
      receiveCount,
      extend: vi.fn(async (seconds: number) => { events.push(`extend ${seconds}`); }),
      delete: vi.fn(async () => { events.push("delete"); }),
      handBack: vi.fn(async () => {
        events.push("hand back");
        fresh.push(make(1));
      }),
    });
    return { first: make(1), next: () => fresh.shift() };
  }

  it("survives three interruptions in a row without spending deliveries, with a new attempt and output key each time", async () => {
    const events: string[] = [];
    const { store, state } = recordingStore(events);
    const { first, next } = queue(events);
    const attempts: number[] = [];
    const keys: string[] = [];
    const hang: HandlerDeps["render"] = (job) => {
      attempts.push(job.attempt);
      keys.push(outputKeyFor(job.id, job.attempt));
      return new Promise(() => undefined);
    };

    let delivery: Delivery | undefined = first;
    for (let round = 0; round < 3; round++) {
      const shutdown = new AbortController();
      const outcome = handleDelivery({ store, render: hang, shutdown: shutdown.signal, config: { ...config, jobTimeoutSeconds: 60, abortGraceSeconds: 0.05 }, log: () => {} }, delivery!);
      await vi.waitFor(() => expect(attempts).toHaveLength(round + 1));
      shutdown.abort();
      expect(await outcome).toBe("interrupted");
      expect(state.job.status).toBe("QUEUED");
      // Not made visible again (that would spend a receive), not deleted outright: handed back as a fresh message.
      expect(delivery!.extend).not.toHaveBeenCalledWith(0);
      delivery = next();
      // The redrive limit is never approached: the job never gets near the dead-letter queue.
      expect(delivery!.receiveCount).toBe(1);
    }

    const render: HandlerDeps["render"] = async (job) => {
      attempts.push(job.attempt);
      keys.push(outputKeyFor(job.id, job.attempt));
      return { ...output, objectKey: outputKeyFor(job.id, job.attempt) };
    };
    expect(await handleDelivery({ store, render, config: { ...config, jobTimeoutSeconds: 60 }, log: () => {} }, delivery!)).toBe("succeeded");
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(new Set(keys).size).toBe(4);
    expect(keys).toEqual(["renders/job-1.mp4", "renders/job-1-2.mp4", "renders/job-1-3.mp4", "renders/job-1-4.mp4"]);
    expect(events.filter((event) => event === "hand back")).toHaveLength(3);
  });

  it("lets a render finish within the shutdown drain", async () => {
    const events: string[] = [];
    const { store, state } = recordingStore(events);
    const { first } = queue(events);
    const shutdown = new AbortController();
    let signal: AbortSignal | undefined;
    const render: HandlerDeps["render"] = async (_job, _progress, scope) => {
      signal = scope.signal;
      shutdown.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return output;
    };
    const outcome = await handleDelivery({ store, render, shutdown: shutdown.signal, config: { ...config, jobTimeoutSeconds: 60, shutdownDrainSeconds: 1 }, log: () => {} }, first);
    expect(outcome).toBe("succeeded");
    expect(signal!.aborted).toBe(false);
    expect(state.job.status).toBe("SUCCEEDED");
  });

  it("stops a render still running when the drain ends", async () => {
    const events: string[] = [];
    const { store } = recordingStore(events);
    const { first } = queue(events);
    const shutdown = new AbortController();
    const started = Date.now();
    const render: HandlerDeps["render"] = () => {
      shutdown.abort();
      return new Promise(() => undefined);
    };
    const outcome = await handleDelivery({ store, render, shutdown: shutdown.signal, config: { ...config, jobTimeoutSeconds: 60, shutdownDrainSeconds: 0.15, abortGraceSeconds: 0.05 }, log: () => {} }, first);
    expect(outcome).toBe("interrupted");
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("stops the heartbeat before handing the message back, so no tick re-hides it", async () => {
    const events: string[] = [];
    const { store } = recordingStore(events);
    const { first } = queue(events);
    const shutdown = new AbortController();
    const render: HandlerDeps["render"] = () => new Promise(() => undefined);
    // Heartbeat every 20 ms, a 200 ms grace: plenty of ticks while the attempt unwinds.
    const outcome = handleDelivery({ store, render, shutdown: shutdown.signal, config: { ...config, heartbeatSeconds: 0.02, jobTimeoutSeconds: 60, abortGraceSeconds: 0.1 }, log: () => {} }, first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    shutdown.abort();
    expect(await outcome).toBe("interrupted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const handedBack = events.indexOf("hand back");
    expect(events.slice(0, handedBack).some((event) => event === "extend 120")).toBe(true);
    expect(events.slice(handedBack + 1).filter((event) => event.startsWith("extend"))).toEqual([]);
  });
});
