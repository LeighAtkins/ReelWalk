import { describe, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@reelwalk/core";
import { handleDeadLetter, handleDelivery, type Delivery, type HandlerDeps, type JobStore, type Lease } from "../src/handler";

const config = { maxAttempts: 3, visibilitySeconds: 120, heartbeatSeconds: 20, staleSeconds: 60, retryBackoffSeconds: 15 };
const output = { objectKey: "renders/job-1.mp4", contentType: "video/mp4", sizeBytes: 1234 };

/** In-memory JobStore holding a single job, mirroring the conditional writes of the Prisma one. */
function fakeStore(initial: JobSnapshot | null) {
  const state = { job: initial ? { ...initial } : null, error: null as string | null, outputs: 0, attempt: 0, published: null as string | null };
  // The Prisma store's predicate: same generation, and the attempt this run's claim wrote.
  const mine = (lease: Lease) => state.job !== null && state.job.generation === lease.generation && state.attempt === lease.attempt;
  const store: JobStore = {
    snapshot: async () => (state.job ? { ...state.job } : null),
    claim: async (message, attempt, staleBefore) => {
      const job = state.job;
      if (!job || job.generation !== message.generation) return null;
      const stale = job.status === "RUNNING" && (!job.heartbeatAt || job.heartbeatAt < staleBefore);
      if (job.status !== "QUEUED" && !stale) return null;
      job.status = "RUNNING";
      job.heartbeatAt = new Date();
      state.attempt = attempt;
      return { id: message.jobId, generation: message.generation, attempt, kind: "TEMPLATE", caption: null, payload: null, inputKey: "uploads/p/a.jpg", brand: null };
    },
    heartbeat: async () => {},
    succeed: async (lease, result) => {
      if (!mine(lease) || state.job!.status !== "RUNNING") return false;
      state.job!.status = "SUCCEEDED";
      state.outputs = 1;
      state.published = result.objectKey;
      return true;
    },
    requeue: async (lease, error) => {
      if (mine(lease) && state.job!.status === "RUNNING") {
        state.job!.status = "QUEUED";
        state.error = error;
      }
    },
    fail: async (lease, error) => {
      if (mine(lease) && (state.job!.status === "RUNNING" || state.job!.status === "QUEUED")) {
        state.job!.status = "FAILED";
        state.error = error;
      }
    },
    failAbandoned: async (message, error) => {
      if (state.job && state.job.generation === message.generation && (state.job.status === "RUNNING" || state.job.status === "QUEUED")) {
        state.job.status = "FAILED";
        state.error = error;
      }
    },
  };
  return { store, state };
}

function fakeDelivery(receiveCount = 1, body = JSON.stringify({ jobId: "job-1", generation: 1 })) {
  return { body, receiveCount, extend: vi.fn(async () => {}), delete: vi.fn(async () => {}) } satisfies Delivery;
}

function deps(store: JobStore, render: HandlerDeps["render"]): HandlerDeps {
  return { store, render, config, log: () => {} };
}

const queued: JobSnapshot = { status: "QUEUED", generation: 1, heartbeatAt: null };

describe("handleDelivery", () => {
  it("fails an attempt that runs past the job deadline so it can be retried", async () => {
    vi.useFakeTimers();
    try {
      const { store, state } = fakeStore(queued);
      const never = () => new Promise<typeof output>(() => undefined);
      const delivery = fakeDelivery(1);
      const outcome = handleDelivery({ store, render: never, config: { ...config, jobTimeoutSeconds: 1 }, log: () => {} }, delivery);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await outcome).toBe("retrying");
      expect(state.job!.status).toBe("QUEUED");
      expect(state.error).toMatch(/exceeded/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish the output of a worker whose job was taken over while it rendered", async () => {
    // Worker A claims (attempt 1), stops heartbeating, worker B takes over (attempt 2) and finishes; then A's render returns.
    const { store, state } = fakeStore(queued);
    let finishA!: (value: typeof output) => void;
    const renderA = () => new Promise<typeof output>((resolve) => { finishA = resolve; });
    const deliveryA = fakeDelivery(1);
    const outcomeA = handleDelivery(deps(store, renderA), deliveryA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.job!.heartbeatAt = new Date(Date.now() - 5 * 60_000);
    const deliveryB = fakeDelivery(2);
    const outputB = { ...output, objectKey: "renders/job-1-2.mp4" };
    expect(await handleDelivery(deps(store, async () => outputB), deliveryB)).toBe("succeeded");
    expect(state.published).toBe("renders/job-1-2.mp4");

    finishA(output);
    expect(await outcomeA).toBe("discarded");
    expect(state.published).toBe("renders/job-1-2.mp4");
    expect(state.job!.status).toBe("SUCCEEDED");
    expect(deliveryA.delete).not.toHaveBeenCalled();
  });

  it("lets a superseded worker's failure neither re-queue nor fail the job", async () => {
    const { store, state } = fakeStore(queued);
    let failA!: (error: Error) => void;
    const renderA = () => new Promise<typeof output>((_, reject) => { failA = reject; });
    const outcomeA = handleDelivery(deps(store, renderA), fakeDelivery(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.job!.heartbeatAt = new Date(Date.now() - 5 * 60_000);
    let finishB!: (value: typeof output) => void;
    const outcomeB = handleDelivery(deps(store, () => new Promise<typeof output>((resolve) => { finishB = resolve; })), fakeDelivery(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    failA(new Error("boom"));
    expect(await outcomeA).toBe("retrying");
    expect(state.job!.status).toBe("RUNNING");
    expect(state.error).toBeNull();

    finishB(output);
    expect(await outcomeB).toBe("succeeded");
    expect(state.job!.status).toBe("SUCCEEDED");
  });

  it("renders a queued job, records the output and deletes the message", async () => {
    const { store, state } = fakeStore(queued);
    const delivery = fakeDelivery();
    const render = vi.fn(async () => output);

    expect(await handleDelivery(deps(store, render), delivery)).toBe("succeeded");
    expect(state.job?.status).toBe("SUCCEEDED");
    expect(state.outputs).toBe(1);
    expect(delivery.delete).toHaveBeenCalledOnce();
  });

  it("does not render again when a finished job is delivered twice", async () => {
    const { store } = fakeStore({ ...queued, status: "SUCCEEDED" });
    const delivery = fakeDelivery(2);
    const render = vi.fn(async () => output);

    expect(await handleDelivery(deps(store, render), delivery)).toBe("discarded");
    expect(render).not.toHaveBeenCalled();
    expect(delivery.delete).toHaveBeenCalledOnce();
  });

  it("leaves the message alone while another worker is rendering", async () => {
    const { store } = fakeStore({ status: "RUNNING", generation: 1, heartbeatAt: new Date() });
    const delivery = fakeDelivery(2);
    const render = vi.fn(async () => output);

    expect(await handleDelivery(deps(store, render), delivery)).toBe("deferred");
    expect(render).not.toHaveBeenCalled();
    expect(delivery.delete).not.toHaveBeenCalled();
    // Hidden for a full visibility period so it does not burn receives while the other worker renders.
    expect(delivery.extend).toHaveBeenCalledWith(config.visibilitySeconds);
  });

  it("takes over a job whose worker stopped heartbeating", async () => {
    const { store, state } = fakeStore({ status: "RUNNING", generation: 1, heartbeatAt: new Date(Date.now() - 5 * 60_000) });
    const delivery = fakeDelivery(2);

    expect(await handleDelivery(deps(store, async () => output), delivery)).toBe("succeeded");
    expect(state.job?.status).toBe("SUCCEEDED");
  });

  it("re-queues with backoff when an attempt fails", async () => {
    const { store, state } = fakeStore(queued);
    const delivery = fakeDelivery(2);
    const render = async () => {
      throw new Error("ffmpeg exploded");
    };

    expect(await handleDelivery(deps(store, render), delivery)).toBe("retrying");
    expect(state.job?.status).toBe("QUEUED");
    expect(state.error).toBe("ffmpeg exploded");
    expect(delivery.extend).toHaveBeenLastCalledWith(30);
    expect(delivery.delete).not.toHaveBeenCalled();
  });

  it("fails the job on the last attempt and leaves the message for the DLQ", async () => {
    const { store, state } = fakeStore(queued);
    const delivery = fakeDelivery(3);
    const render = async () => {
      throw new Error("still broken");
    };

    expect(await handleDelivery(deps(store, render), delivery)).toBe("failed");
    expect(state.job?.status).toBe("FAILED");
    expect(delivery.delete).not.toHaveBeenCalled();
  });

  it("ignores a message from before a manual retry", async () => {
    const { store, state } = fakeStore({ ...queued, generation: 2 });
    const delivery = fakeDelivery();
    const render = vi.fn(async () => output);

    expect(await handleDelivery(deps(store, render), delivery)).toBe("discarded");
    expect(render).not.toHaveBeenCalled();
    expect(state.job?.status).toBe("QUEUED");
  });

  it("leaves unparseable messages for the DLQ", async () => {
    const { store } = fakeStore(queued);
    const delivery = fakeDelivery(1, "not json");

    expect(await handleDelivery(deps(store, async () => output), delivery)).toBe("poison");
    expect(delivery.delete).not.toHaveBeenCalled();
  });
});

describe("handleDeadLetter", () => {
  it("fails a job that crashed its worker on every attempt", async () => {
    const { store, state } = fakeStore({ status: "RUNNING", generation: 1, heartbeatAt: new Date(Date.now() - 5 * 60_000) });
    const delivery = fakeDelivery(4);

    expect(await handleDeadLetter({ store, config, log: () => {} }, delivery)).toBe("failed");
    expect(state.job?.status).toBe("FAILED");
    expect(delivery.delete).toHaveBeenCalledOnce();
  });

  it("spares a job that another worker is still rendering", async () => {
    const { store, state } = fakeStore({ status: "RUNNING", generation: 1, heartbeatAt: new Date() });
    const delivery = fakeDelivery(4);

    expect(await handleDeadLetter({ store, config, log: () => {} }, delivery)).toBe("ignored");
    expect(state.job?.status).toBe("RUNNING");
    expect(delivery.delete).toHaveBeenCalledOnce();
  });

  it("does not touch a job that was manually retried since", async () => {
    const { store, state } = fakeStore({ ...queued, generation: 2 });
    const delivery = fakeDelivery(4);

    expect(await handleDeadLetter({ store, config, log: () => {} }, delivery)).toBe("ignored");
    expect(state.job?.status).toBe("QUEUED");
    expect(delivery.delete).toHaveBeenCalledOnce();
  });
});
