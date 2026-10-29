import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config";

describe("getConfig", () => {
  it("defaults to stopping a render at once on SIGTERM, inside ECS's 30 s stop timeout", () => {
    const config = getConfig({});
    expect(config.shutdownDrainSeconds).toBe(0);
    expect(config.shutdownDrainSeconds + 2 * config.abortGraceSeconds + 5).toBeLessThanOrEqual(config.stopTimeoutSeconds);
  });

  it("accepts a drain that fits a long Kubernetes termination grace", () => {
    expect(getConfig({ RENDER_SHUTDOWN_DRAIN_SECONDS: "270", RENDER_STOP_TIMEOUT_SECONDS: "300" }).shutdownDrainSeconds).toBe(270);
  });

  it("refuses a drain and grace that cannot finish before the platform's SIGKILL", () => {
    expect(() => getConfig({ RENDER_SHUTDOWN_DRAIN_SECONDS: "20" })).toThrow(/RENDER_STOP_TIMEOUT_SECONDS/);
    expect(() => getConfig({ RENDER_ABORT_GRACE_SECONDS: "15" })).toThrow(/RENDER_STOP_TIMEOUT_SECONDS/);
  });

  it("is a cloud worker unless WORKER_MODE=local, which takes the heavy lock it is given (ADR 0094)", () => {
    expect(getConfig({})).toMatchObject({ mode: "cloud", localQueueUrl: undefined, heavyLockDir: undefined });
    expect(getConfig({ WORKER_MODE: "local", SQS_QUEUE_URL: "https://sqs/local", HEAVY_LOCK_DIR: "/heavy/.heavy.lock" }))
      .toMatchObject({ mode: "local", queueUrl: "https://sqs/local", heavyLockDir: "/heavy/.heavy.lock", heavyLockOwner: "reelwalk-local-worker" });
    expect(getConfig({ LOCAL_RENDER_QUEUE_URL: "https://sqs/local" }).localQueueUrl).toBe("https://sqs/local");
  });
});
