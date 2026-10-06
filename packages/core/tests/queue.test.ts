import { describe, expect, it } from "vitest";
import {
  decideDelivery,
  decideFailure,
  parseRenderJobMessage,
  retryDelaySeconds,
  serializeRenderJobMessage,
  shouldFailFromDeadLetter,
  type JobSnapshot,
} from "../src";

const now = new Date("2026-10-04T12:00:00Z");
const message = { jobId: "job-1", generation: 1 };
const staleAfterMs = 60_000;

describe("render job messages", () => {
  it("round-trips a message", () => {
    expect(parseRenderJobMessage(serializeRenderJobMessage(message))).toEqual(message);
  });

  it("rejects malformed payloads", () => {
    expect(() => parseRenderJobMessage("{}")).toThrow();
    expect(() => parseRenderJobMessage('{"jobId":"","generation":1}')).toThrow();
    expect(() => parseRenderJobMessage("not json")).toThrow();
  });
});

describe("decideDelivery", () => {
  it("claims a queued job", () => {
    const job = { status: "QUEUED" as const, generation: 1, heartbeatAt: null };
    expect(decideDelivery({ job, message, now, staleAfterMs })).toBe("claim");
  });

  it("discards a duplicate delivery of a finished job", () => {
    const job = { status: "SUCCEEDED" as const, generation: 1, heartbeatAt: now };
    expect(decideDelivery({ job, message, now, staleAfterMs })).toBe("discard");
  });

  it("discards messages for a missing job", () => {
    expect(decideDelivery({ job: null, message, now, staleAfterMs })).toBe("discard");
  });

  it("discards a message from before a manual retry", () => {
    const job = { status: "QUEUED" as const, generation: 2, heartbeatAt: null };
    expect(decideDelivery({ job, message, now, staleAfterMs })).toBe("discard");
  });

  it("defers while another worker is still heartbeating", () => {
    const job = { status: "RUNNING" as const, generation: 1, heartbeatAt: new Date(now.getTime() - 10_000) };
    expect(decideDelivery({ job, message, now, staleAfterMs })).toBe("defer");
  });

  it("reclaims a running job whose worker stopped heartbeating", () => {
    const job = { status: "RUNNING" as const, generation: 1, heartbeatAt: new Date(now.getTime() - 61_000) };
    expect(decideDelivery({ job, message, now, staleAfterMs })).toBe("claim");
  });
});

describe("decideFailure", () => {
  it("backs off exponentially", () => {
    expect(retryDelaySeconds(1, 15)).toBe(15);
    expect(retryDelaySeconds(2, 15)).toBe(30);
    expect(retryDelaySeconds(3, 15)).toBe(60);
    expect(retryDelaySeconds(20, 15)).toBe(900);
  });

  it("re-queues until attempts are exhausted", () => {
    expect(decideFailure({ attempt: 1, maxAttempts: 3, backoffBaseSeconds: 15 })).toEqual({
      status: "QUEUED",
      retryDelaySeconds: 15,
    });
    expect(decideFailure({ attempt: 2, maxAttempts: 3, backoffBaseSeconds: 15 })).toEqual({
      status: "QUEUED",
      retryDelaySeconds: 30,
    });
    expect(decideFailure({ attempt: 3, maxAttempts: 3, backoffBaseSeconds: 15 })).toEqual({ status: "FAILED" });
  });
});

describe("shouldFailFromDeadLetter", () => {
  const decide = (job: JobSnapshot | null) => shouldFailFromDeadLetter({ job, message, now, staleAfterMs });

  it("fails a job whose worker died without reporting", () => {
    expect(decide({ status: "RUNNING", generation: 1, heartbeatAt: null })).toBe(true);
    expect(decide({ status: "RUNNING", generation: 1, heartbeatAt: new Date(now.getTime() - 5 * 60_000) })).toBe(true);
    expect(decide({ status: "QUEUED", generation: 1, heartbeatAt: null })).toBe(true);
  });

  it("spares a job that another worker is still rendering", () => {
    // A duplicate message deferred three times lands in the DLQ while the real render is fine.
    expect(decide({ status: "RUNNING", generation: 1, heartbeatAt: new Date(now.getTime() - 10_000) })).toBe(false);
  });

  it("leaves finished jobs and newer generations alone", () => {
    expect(decide({ status: "FAILED", generation: 1, heartbeatAt: null })).toBe(false);
    expect(decide({ status: "QUEUED", generation: 2, heartbeatAt: null })).toBe(false);
    expect(decide(null)).toBe(false);
  });
});
