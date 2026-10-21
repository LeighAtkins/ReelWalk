import { describe, expect, it, vi } from "vitest";
import { serializeAiStepMessage, type AiStepSnapshot } from "@reelwalk/core";
import { handleAiStepDeadLetter, handleAiStepDelivery, stripImages, type AiStepDeps, type AiStepExecutor, type AiStepStore, type StepLease } from "../src/ai-jobs";
import { handleDeadLetter, handleDelivery, type Delivery, type JobStore } from "../src/handler";

const config = { maxAttempts: 3, visibilitySeconds: 120, heartbeatSeconds: 20, staleSeconds: 60, retryBackoffSeconds: 15, abortGraceSeconds: 0.1 };
const body = serializeAiStepMessage({ stepId: "step-1", generation: 1 });

/** In-memory AiStepStore holding one step, mirroring the conditional writes of the Prisma one. */
function fakeStore(initial: Partial<AiStepSnapshot> | null) {
  const state = {
    step: initial ? { status: "QUEUED", generation: 1, heartbeatAt: null, submittedAt: null, cancelRequested: false, ...initial } as AiStepSnapshot : null,
    // A step found RUNNING has had one attempt already; the claim increments the counter, as the Prisma store does.
    attempt: initial?.status === "RUNNING" ? 1 : 0, error: null as string | null, result: null as unknown, submissions: 0,
  };
  const mine = (lease: StepLease) => state.step !== null && state.step.status === "RUNNING" && state.step.generation === lease.generation && state.attempt === lease.attempt;
  const settle = (status: AiStepSnapshot["status"], error: string | null) => { state.step!.status = status; state.error = error; };
  const store: AiStepStore = {
    snapshot: async () => (state.step ? { ...state.step } : null),
    claim: async (message, staleBefore) => {
      const step = state.step;
      if (!step || step.generation !== message.generation || step.submittedAt || step.cancelRequested) return null;
      const stale = step.status === "RUNNING" && (!step.heartbeatAt || step.heartbeatAt < staleBefore);
      if (step.status !== "QUEUED" && !stale) return null;
      step.status = "RUNNING"; step.heartbeatAt = new Date(); const attempt = ++state.attempt;
      return { id: "step-1", runId: "run-1", kind: "director-review", generation: 1, attempt, payload: {}, reelId: "reel", user: { id: "u", workspaceId: "w" } };
    },
    heartbeat: async () => {},
    markSubmitted: async (lease) => {
      if (!mine(lease) || state.step!.submittedAt || state.step!.cancelRequested) return { ok: false, cancelled: Boolean(state.step?.cancelRequested) };
      state.step!.submittedAt = new Date(); state.submissions += 1;
      return { ok: true };
    },
    succeed: async (lease, result) => {
      if (!mine(lease)) return false;
      settle("SUCCEEDED", null); state.result = result;
      return true;
    },
    requeue: async (lease, error) => { if (mine(lease) && !state.step!.submittedAt) settle("QUEUED", error); },
    fail: async (lease, error) => { if (mine(lease)) settle("FAILED", error); },
    unresolve: async (lease, error) => { if (mine(lease)) settle("UNRESOLVED", error); },
    settleAbandoned: async (message, status, error, staleBefore) => {
      const step = state.step;
      if (!step || step.generation !== message.generation) return;
      const open = step.status === "QUEUED" || (step.status === "RUNNING" && (!step.heartbeatAt || step.heartbeatAt < staleBefore));
      if (open && (status === "UNRESOLVED" || !step.submittedAt)) settle(status, error);
    },
    reapAbandoned: async () => ({ requeued: 0, failed: 0, unresolved: 0 }),
  };
  return { store, state };
}

function fakeDelivery(receiveCount = 1, raw = body) {
  return { body: raw, receiveCount, extend: vi.fn(async () => {}), delete: vi.fn(async () => {}) } satisfies Delivery;
}

/** An executor that behaves like runAiStep: optional work before the paid request, the request, then checks on the answer. */
function executor(behaviour: { before?: () => void; provider?: () => Promise<unknown>; after?: (answer: unknown) => unknown } = {}) {
  const calls = { provider: 0 };
  const value: AiStepExecutor = {
    run: async (_step, gate) => {
      behaviour.before?.();
      await gate.beforeRequest();
      calls.provider += 1;
      const answer = await (behaviour.provider ?? (async () => ({ ok: true, editId: "edit", baselineGeneration: "tg1-x" })))();
      gate.answered();
      return behaviour.after ? behaviour.after(answer) : answer;
    },
    describeError: (_step, error) => `Opus could not finish: ${(error as Error).message}`,
  };
  return { value, calls };
}

const deps = (store: AiStepStore, exec: AiStepExecutor, extra: Partial<AiStepDeps["config"]> = {}): AiStepDeps => ({ store, executor: exec, config: { ...config, ...extra }, log: () => {} });
const ago = (ms: number) => new Date(Date.now() - ms);

describe("handleAiStepDelivery", () => {
  it("runs a queued step once, records the submission and publishes the proposal with its baseline", async () => {
    const { store, state } = fakeStore({});
    const exec = executor();
    const delivery = fakeDelivery();
    expect(await handleAiStepDelivery(deps(store, exec.value), delivery)).toBe("succeeded");
    expect(state.step!.status).toBe("SUCCEEDED");
    expect(state.submissions).toBe(1);
    expect(state.result).toMatchObject({ editId: "edit", baselineGeneration: "tg1-x" });
    expect(delivery.delete).toHaveBeenCalled();
  });

  it("deletes a duplicate message for a finished step without running it", async () => {
    const { store } = fakeStore({ status: "SUCCEEDED" });
    const exec = executor();
    const delivery = fakeDelivery(2);
    expect(await handleAiStepDelivery(deps(store, exec.value), delivery)).toBe("discarded");
    expect(exec.calls.provider).toBe(0);
    expect(delivery.delete).toHaveBeenCalled();
  });

  it("leaves a step with a fresh lease to the worker holding it", async () => {
    const { store } = fakeStore({ status: "RUNNING", heartbeatAt: ago(5_000) });
    const exec = executor();
    const delivery = fakeDelivery(2);
    expect(await handleAiStepDelivery(deps(store, exec.value), delivery)).toBe("deferred");
    expect(exec.calls.provider).toBe(0);
    expect(delivery.extend).toHaveBeenCalledWith(120);
  });

  it("reclaims a stale lease that never reached the provider and runs it", async () => {
    const { store, state } = fakeStore({ status: "RUNNING", heartbeatAt: ago(5 * 60_000) });
    const exec = executor();
    expect(await handleAiStepDelivery(deps(store, exec.value), fakeDelivery(2))).toBe("succeeded");
    expect(state.attempt).toBe(2);
    expect(exec.calls.provider).toBe(1);
  });

  it("never re-runs a stale step that was submitted: it becomes unresolved", async () => {
    // The web restart / worker crash case: the paid request went out and nobody heard back.
    const { store, state } = fakeStore({ status: "RUNNING", heartbeatAt: ago(5 * 60_000), submittedAt: ago(5 * 60_000) });
    const exec = executor();
    const delivery = fakeDelivery(2);
    expect(await handleAiStepDelivery(deps(store, exec.value), delivery)).toBe("failed");
    expect(state.step!.status).toBe("UNRESOLVED");
    expect(exec.calls.provider).toBe(0);
    expect(delivery.delete).toHaveBeenCalled();
  });

  it("retries a failure that happened before the provider request", async () => {
    const { store, state } = fakeStore({});
    const exec = executor({ before: () => { throw new Error("database blip"); } });
    const delivery = fakeDelivery(1);
    expect(await handleAiStepDelivery(deps(store, exec.value), delivery)).toBe("retrying");
    expect(state.step!.status).toBe("QUEUED");
    expect(state.submissions).toBe(0);
    expect(delivery.extend).toHaveBeenCalledWith(15);
  });

  it("marks a lost provider connection unresolved and does not retry, even with attempts left", async () => {
    const { store, state } = fakeStore({});
    const exec = executor({ provider: async () => { throw new Error("socket hang up"); } });
    const delivery = fakeDelivery(1);
    expect(await handleAiStepDelivery(deps(store, exec.value), delivery)).toBe("failed");
    expect(state.step!.status).toBe("UNRESOLVED");
    expect(delivery.delete).toHaveBeenCalled();
    // Redelivery of the same message (SQS at-least-once) finds it settled and sends nothing.
    expect(await handleAiStepDelivery(deps(store, exec.value), fakeDelivery(2))).toBe("discarded");
    expect(exec.calls.provider).toBe(1);
  });

  it("fails, without retrying, when the provider answered but the answer was refused", async () => {
    const { store, state } = fakeStore({});
    const exec = executor({ after: () => { throw new Error("Opus reported ready without enough AI source-frame evidence."); } });
    expect(await handleAiStepDelivery(deps(store, exec.value), fakeDelivery(1))).toBe("failed");
    expect(state.step!.status).toBe("FAILED");
    expect(state.error).toMatch(/^Opus could not finish/);
    expect(exec.calls.provider).toBe(1);
  });

  it("an attempt that times out after submitting is unresolved", async () => {
    vi.useFakeTimers();
    try {
      const { store, state } = fakeStore({});
      const exec = executor({ provider: () => new Promise(() => undefined) });
      const outcome = handleAiStepDelivery(deps(store, exec.value, { aiStepTimeoutSeconds: 1 }), fakeDelivery(1));
      await vi.advanceTimersByTimeAsync(1500);
      expect(await outcome).toBe("failed");
      expect(state.step!.status).toBe("UNRESOLVED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours Stop: a queued step is failed without being run", async () => {
    const { store, state } = fakeStore({ cancelRequested: true });
    const exec = executor();
    expect(await handleAiStepDelivery(deps(store, exec.value), fakeDelivery(1))).toBe("failed");
    expect(state.step!.status).toBe("FAILED");
    expect(exec.calls.provider).toBe(0);
  });

  it("honours Stop pressed while the step was preparing: nothing is sent", async () => {
    const { store, state } = fakeStore({});
    const exec = executor({ before: () => { state.step!.cancelRequested = true; } });
    expect(await handleAiStepDelivery(deps(store, exec.value), fakeDelivery(1))).toBe("failed");
    expect(state.step!.status).toBe("FAILED");
    expect(state.submissions).toBe(0);
    expect(exec.calls.provider).toBe(0);
  });

  it("records the submission once for parallel provider requests and stays unresolved while one is unanswered", async () => {
    const { store, state } = fakeStore({});
    const exec: AiStepExecutor = {
      run: async (_step, gate) => {
        await Promise.all([gate.beforeRequest(), gate.beforeRequest()]);
        gate.answered(); // the room labels came back; the edit plan request never did
        throw new Error("socket hang up");
      },
      describeError: () => "x",
    };
    expect(await handleAiStepDelivery(deps(store, exec), fakeDelivery(1))).toBe("failed");
    expect(state.submissions).toBe(1);
    expect(state.step!.status).toBe("UNRESOLVED");
  });

  it("retries a step that never made a provider request (the fake model), whatever went wrong", async () => {
    const { store, state } = fakeStore({});
    const exec: AiStepExecutor = { run: async () => { throw new Error("Connection terminated unexpectedly"); }, describeError: () => "x" };
    expect(await handleAiStepDelivery(deps(store, exec), fakeDelivery(1))).toBe("retrying");
    expect(state.step!.status).toBe("QUEUED");
  });

  it("ends a stopped step as stopped even when the step code swallowed the refusal", async () => {
    const { store, state } = fakeStore({});
    const exec: AiStepExecutor = {
      run: async (_step, gate) => {
        state.step!.cancelRequested = true;
        try { await gate.beforeRequest(); } catch { return { ok: false, message: "The model could not be reached." }; }
        return { ok: true };
      },
      describeError: () => "x",
    };
    expect(await handleAiStepDelivery(deps(store, exec), fakeDelivery(1))).toBe("failed");
    expect(state.step!.status).toBe("FAILED");
    expect(state.error).toMatch(/^Stopped/);
    expect(state.result).toBeNull();
  });

  it("settles a polite { ok: false } as unresolved while a sent request is unanswered", async () => {
    // askForChange turns "Could not reach Claude." into { ok: false, message }: not a definite outcome.
    const { store, state } = fakeStore({});
    const exec: AiStepExecutor = { run: async (_step, gate) => { await gate.beforeRequest(); return { ok: false, message: "The model did not answer." }; }, describeError: () => "x" };
    expect(await handleAiStepDelivery(deps(store, exec), fakeDelivery(1))).toBe("failed");
    expect(state.step!.status).toBe("UNRESOLVED");
    expect(state.result).toBeNull();
  });

  it("publishes a { ok: false } whose requests were all answered (a definite refusal)", async () => {
    const { store, state } = fakeStore({});
    const exec: AiStepExecutor = { run: async (_step, gate) => { await gate.beforeRequest(); gate.answered(); return { ok: false, message: "Keep the request under 600 characters." }; }, describeError: () => "x" };
    expect(await handleAiStepDelivery(deps(store, exec), fakeDelivery(1))).toBe("succeeded");
    expect(state.step!.status).toBe("SUCCEEDED");
  });

  it("aborts the step's signal at the deadline so it cannot start more paid requests", async () => {
    vi.useFakeTimers();
    try {
      const { store, state } = fakeStore({});
      let signal: AbortSignal | undefined;
      const exec: AiStepExecutor = { run: (_step, gate) => { signal = gate.signal; return new Promise(() => undefined); }, describeError: () => "x" };
      const outcome = handleAiStepDelivery(deps(store, exec, { aiStepTimeoutSeconds: 1 }), fakeDelivery(1));
      await vi.advanceTimersByTimeAsync(1500);
      await outcome;
      expect(signal?.aborted).toBe(true);
      expect(state.submissions).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands an unsent step back on shutdown without spending a delivery", async () => {
    const { store, state } = fakeStore({});
    const shutdown = new AbortController();
    const exec: AiStepExecutor = { run: (_step, gate) => new Promise((_, reject) => { gate.signal?.addEventListener("abort", () => reject(gate.signal!.reason)); shutdown.abort(); }), describeError: () => "x" };
    const delivery = { ...fakeDelivery(1), handBack: vi.fn(async () => {}) };
    expect(await handleAiStepDelivery({ ...deps(store, exec), shutdown: shutdown.signal }, delivery)).toBe("interrupted");
    expect(state.step!.status).toBe("QUEUED");
    expect(delivery.handBack).toHaveBeenCalled();
    expect(state.submissions).toBe(0);
  });

  it("never hands back a step that was sent: shutdown with an unanswered request is unresolved", async () => {
    const { store, state } = fakeStore({});
    const shutdown = new AbortController();
    const exec: AiStepExecutor = {
      run: async (_step, gate) => {
        await gate.beforeRequest();
        shutdown.abort();
        return new Promise((_, reject) => gate.signal?.addEventListener("abort", () => reject(gate.signal!.reason)));
      },
      describeError: () => "x",
    };
    const delivery = { ...fakeDelivery(1), handBack: vi.fn(async () => {}) };
    expect(await handleAiStepDelivery({ ...deps(store, exec), shutdown: shutdown.signal }, delivery)).toBe("failed");
    expect(state.step!.status).toBe("UNRESOLVED");
    expect(delivery.handBack).not.toHaveBeenCalled();
  });

  it("does not publish when the lease was lost while running", async () => {
    const { store, state } = fakeStore({});
    const exec = executor({ provider: async () => { state.attempt = 99; return { ok: true }; } });
    const delivery = fakeDelivery(1);
    expect(await handleAiStepDelivery(deps(store, exec.value), delivery)).toBe("discarded");
    expect(state.result).toBeNull();
    expect(delivery.delete).not.toHaveBeenCalled();
  });

  it("leaves an unreadable step message for the dead-letter queue", async () => {
    const { store } = fakeStore({});
    const delivery = fakeDelivery(1, JSON.stringify({ type: "ai-step", stepId: "" }));
    expect(await handleAiStepDelivery(deps(store, executor().value), delivery)).toBe("poison");
    expect(delivery.delete).not.toHaveBeenCalled();
  });
});

describe("handleAiStepDeadLetter", () => {
  it("fails an abandoned step that never reached the provider and marks a submitted one unresolved", async () => {
    const never = fakeStore({ status: "RUNNING", heartbeatAt: ago(5 * 60_000) });
    expect(await handleAiStepDeadLetter({ store: never.store, config, log: () => {} }, fakeDelivery())).toBe("failed");
    expect(never.state.step!.status).toBe("FAILED");
    const sent = fakeStore({ status: "RUNNING", heartbeatAt: ago(5 * 60_000), submittedAt: ago(5 * 60_000) });
    expect(await handleAiStepDeadLetter({ store: sent.store, config, log: () => {} }, fakeDelivery())).toBe("failed");
    expect(sent.state.step!.status).toBe("UNRESOLVED");
  });

  it("keeps the dead letter of a step a live worker holds, so it can settle it later", async () => {
    const { store, state } = fakeStore({ status: "RUNNING", heartbeatAt: ago(1000) });
    const delivery = fakeDelivery();
    expect(await handleAiStepDeadLetter({ store, config, log: () => {} }, delivery)).toBe("ignored");
    expect(delivery.delete).not.toHaveBeenCalled();
    expect(state.step!.status).toBe("RUNNING");
  });

  it("ignores a settled step", async () => {
    const { store, state } = fakeStore({ status: "SUCCEEDED" });
    expect(await handleAiStepDeadLetter({ store, config, log: () => {} }, fakeDelivery())).toBe("ignored");
    expect(state.step!.status).toBe("SUCCEEDED");
  });
});

describe("render handler dispatch", () => {
  const renderStore = { snapshot: vi.fn(async () => null) } as unknown as JobStore;

  it("hands AI step messages to the AI path and leaves render messages alone", async () => {
    const { store, state } = fakeStore({});
    const render = vi.fn();
    const aiSteps = deps(store, executor().value);
    expect(await handleDelivery({ store: renderStore, render, config, aiSteps, log: () => {} }, fakeDelivery())).toBe("succeeded");
    expect(state.step!.status).toBe("SUCCEEDED");
    expect(render).not.toHaveBeenCalled();
    expect(await handleDelivery({ store: renderStore, render, config, aiSteps, log: () => {} }, fakeDelivery(1, JSON.stringify({ jobId: "job-1", generation: 1 })))).toBe("discarded");
    expect(renderStore.snapshot).toHaveBeenCalledWith("job-1");
  });

  it("routes AI step dead letters too", async () => {
    const { store, state } = fakeStore({ status: "QUEUED" });
    expect(await handleDeadLetter({ store: renderStore, config, aiSteps: deps(store, executor().value), log: () => {} }, fakeDelivery())).toBe("failed");
    expect(state.step!.status).toBe("FAILED");
  });
});

describe("stripImages", () => {
  it("drops review frame images and keeps their timestamps", () => {
    expect(stripImages({ request: "x", evidence: [{ assetId: "a", timesMs: [0], image: "data:image/jpeg;base64,AAAA" }] })).toEqual({ request: "x", evidence: [{ assetId: "a", timesMs: [0] }] });
    expect(stripImages({ request: "x" })).toEqual({ request: "x" });
  });
});
