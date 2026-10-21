import { describe, expect, it } from "vitest";
import {
  advanceDirectorRun, baselineMatches, canWorkflowTransition, checkDirectorRunStep, decideAiStepDeadLetter, decideAiStepDelivery, decideAiStepFailure,
  decideAiStepReap, decideRequestIdentity, isAiStepMessage, isWorkflowTerminal, parseAiStepMessage, pollAnswer, serializeAiStepMessage, stableStringify, timelineGeneration,
  WORKFLOW_STATUSES, type AiStepSnapshot, type DirectorRunSnapshot,
} from "../src";

const now = new Date("2026-10-21T12:00:00Z");
const stale = 60_000;
const step = (over: Partial<AiStepSnapshot> = {}): AiStepSnapshot => ({ status: "QUEUED", generation: 1, heartbeatAt: null, submittedAt: null, cancelRequested: false, ...over });
const ago = (ms: number) => new Date(now.getTime() - ms);
const timeline = { version: 1, clips: [{ id: "c1", assetId: "a1", durationMs: 2000 }], texts: [], audio: null };

describe("workflow state transitions", () => {
  it("only moves forward, and terminal states are final", () => {
    expect(canWorkflowTransition("QUEUED", "RUNNING")).toBe(true);
    expect(canWorkflowTransition("RUNNING", "SUCCEEDED")).toBe(true);
    expect(canWorkflowTransition("RUNNING", "UNRESOLVED")).toBe(true);
    expect(canWorkflowTransition("QUEUED", "SUCCEEDED")).toBe(false);
    for (const terminal of ["SUCCEEDED", "FAILED", "UNRESOLVED"] as const) {
      expect(isWorkflowTerminal(terminal)).toBe(true);
      for (const to of WORKFLOW_STATUSES) expect(canWorkflowTransition(terminal, to)).toBe(false);
    }
  });

  it("never lets a submitted step go back to the queue or run again", () => {
    expect(canWorkflowTransition("RUNNING", "QUEUED", { submitted: false })).toBe(true);
    expect(canWorkflowTransition("RUNNING", "QUEUED", { submitted: true })).toBe(false);
    expect(canWorkflowTransition("QUEUED", "RUNNING", { submitted: true })).toBe(false);
  });
});

describe("step messages", () => {
  it("round-trips and is told apart from render job messages", () => {
    const body = serializeAiStepMessage({ stepId: "s1", generation: 2 });
    expect(parseAiStepMessage(body)).toEqual({ type: "ai-step", stepId: "s1", generation: 2 });
    expect(isAiStepMessage(body)).toBe(true);
    expect(isAiStepMessage(JSON.stringify({ jobId: "j", generation: 1 }))).toBe(false);
    expect(isAiStepMessage("not json")).toBe(false);
    expect(isAiStepMessage("null")).toBe(false);
  });
});

describe("delivery decisions", () => {
  it("claims a queued step and discards stale or settled ones", () => {
    expect(decideAiStepDelivery({ step: step(), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("claim");
    expect(decideAiStepDelivery({ step: null, message: { generation: 1 }, now, staleAfterMs: stale })).toBe("discard");
    expect(decideAiStepDelivery({ step: step({ generation: 2 }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("discard");
    expect(decideAiStepDelivery({ step: step({ status: "SUCCEEDED" }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("discard");
    expect(decideAiStepDelivery({ step: step({ status: "UNRESOLVED" }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("discard");
  });

  it("leaves a step with a fresh lease to its worker", () => {
    expect(decideAiStepDelivery({ step: step({ status: "RUNNING", heartbeatAt: ago(10_000) }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("defer");
  });

  it("reclaims a stale lease that never reached the provider", () => {
    expect(decideAiStepDelivery({ step: step({ status: "RUNNING", heartbeatAt: ago(120_000) }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("claim");
    expect(decideAiStepDelivery({ step: step({ status: "RUNNING", heartbeatAt: null }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("claim");
  });

  it("marks a stale submitted step unresolved instead of running it again", () => {
    expect(decideAiStepDelivery({ step: step({ status: "RUNNING", heartbeatAt: ago(120_000), submittedAt: ago(119_000) }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("unresolve");
    expect(decideAiStepDelivery({ step: step({ status: "QUEUED", submittedAt: ago(1000) }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("unresolve");
  });

  it("honours Stop before the step starts", () => {
    expect(decideAiStepDelivery({ step: step({ cancelRequested: true }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("cancel");
    expect(decideAiStepDelivery({ step: step({ status: "RUNNING", heartbeatAt: ago(120_000), cancelRequested: true }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("cancel");
  });
});

describe("failure decisions", () => {
  const base = { maxAttempts: 3, backoffBaseSeconds: 10 };
  it("retries an attempt that never reached the provider, then fails", () => {
    expect(decideAiStepFailure({ ...base, attempt: 1, submitted: false, answered: false })).toEqual({ status: "QUEUED", retryDelaySeconds: 10 });
    expect(decideAiStepFailure({ ...base, attempt: 2, submitted: false, answered: false })).toEqual({ status: "QUEUED", retryDelaySeconds: 20 });
    expect(decideAiStepFailure({ ...base, attempt: 3, submitted: false, answered: false })).toEqual({ status: "FAILED" });
  });

  it("never retries a submitted request: unresolved without an answer, failed with one", () => {
    expect(decideAiStepFailure({ ...base, attempt: 1, submitted: true, answered: false })).toEqual({ status: "UNRESOLVED" });
    expect(decideAiStepFailure({ ...base, attempt: 1, submitted: true, answered: true })).toEqual({ status: "FAILED" });
  });

  it("settles dead letters by whether the provider may have been reached", () => {
    expect(decideAiStepDeadLetter({ step: step({ status: "RUNNING", heartbeatAt: ago(120_000) }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("fail");
    expect(decideAiStepDeadLetter({ step: step({ status: "RUNNING", heartbeatAt: ago(120_000), submittedAt: ago(119_000) }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("unresolve");
    expect(decideAiStepDeadLetter({ step: step({ status: "RUNNING", heartbeatAt: ago(1000) }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("wait");
    expect(decideAiStepDeadLetter({ step: step({ status: "SUCCEEDED" }), message: { generation: 1 }, now, staleAfterMs: stale })).toBe("ignore");
  });
});

describe("reaper", () => {
  const base = { status: "QUEUED" as const, createdAt: ago(45 * 60_000), updatedAt: ago(45 * 60_000), heartbeatAt: null, submittedAt: null, outboxPending: false };
  it("re-enqueues an old queued step instead of failing it: its message may still be in the queue", () => {
    expect(decideAiStepReap(base, now)).toBe("requeue");
  });
  it("fails a queued step only once no message for it can exist (past the queue's retention)", () => {
    expect(decideAiStepReap({ ...base, createdAt: ago(5 * 24 * 60 * 60_000) }, now)).toBe("fail");
  });
  it("settles a silent running step by whether it was sent", () => {
    expect(decideAiStepReap({ ...base, status: "RUNNING", heartbeatAt: ago(31 * 60_000) }, now)).toBe("fail");
    expect(decideAiStepReap({ ...base, status: "RUNNING", heartbeatAt: ago(31 * 60_000), submittedAt: ago(31 * 60_000) }, now)).toBe("unresolve");
  });
  it("keeps recent, live, unsent-outbox and settled steps", () => {
    expect(decideAiStepReap({ ...base, updatedAt: ago(60_000) }, now)).toBe("keep");
    expect(decideAiStepReap({ ...base, status: "RUNNING", heartbeatAt: ago(10_000) }, now)).toBe("keep");
    expect(decideAiStepReap({ ...base, outboxPending: true }, now)).toBe("keep");
    expect(decideAiStepReap({ ...base, status: "SUCCEEDED" }, now)).toBe("keep");
  });
});

describe("request identity", () => {
  const id = { workspaceId: "w", reelId: "r", kind: "director", requestHash: "h1" };
  it("creates, resumes the same request, and refuses a changed one", () => {
    expect(decideRequestIdentity(null, id)).toBe("create");
    expect(decideRequestIdentity(id, { ...id })).toBe("resume");
    expect(decideRequestIdentity(id, { ...id, requestHash: "h2" })).toBe("conflict");
    expect(decideRequestIdentity(id, { ...id, workspaceId: "other" })).toBe("conflict");
    expect(decideRequestIdentity(id, { ...id, reelId: "other" })).toBe("conflict");
  });

  it("hashes payloads independently of key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(stableStringify({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
  });
});

describe("baseline generation", () => {
  it("is stable for the same edit and changes with the edit", () => {
    expect(timelineGeneration(timeline)).toBe(timelineGeneration(JSON.parse(JSON.stringify(timeline))));
    const changed = { ...timeline, clips: [{ ...timeline.clips[0], durationMs: 2500 }] };
    expect(timelineGeneration(changed)).not.toBe(timelineGeneration(timeline));
  });

  it("refuses a proposal made from another baseline", () => {
    const generation = timelineGeneration(timeline);
    expect(baselineMatches(timeline, generation)).toBe(true);
    expect(baselineMatches({ ...timeline, clips: [] }, generation)).toBe(false);
    expect(baselineMatches(timeline, null)).toBe(false);
  });
});

describe("poll answers", () => {
  it("report persisted state only", () => {
    expect(pollAnswer({ status: "RUNNING", result: null, error: null })).toEqual({ status: "RUNNING", durable: true });
    expect(pollAnswer({ status: "QUEUED", result: null, error: null })).toEqual({ status: "QUEUED", durable: true });
    expect(pollAnswer({ status: "SUCCEEDED", result: { ok: true }, error: null })).toEqual({ status: "DONE", durable: true, result: { ok: true } });
    expect(pollAnswer({ status: "UNRESOLVED", result: null, error: null })).toMatchObject({ status: "UNRESOLVED" });
  });
});

describe("director run", () => {
  const run = (over: Partial<DirectorRunSnapshot> = {}): DirectorRunSnapshot => ({ status: "RUNNING", cancelRequested: false, round: 0, maxRounds: 4, budgetCredits: 3, spentCredits: 0, expectedBaseline: null, stepActive: false, stepCount: 0, ...over });

  it("adds a review only when the run is idle, not stopped, and on the expected baseline", () => {
    expect(checkDirectorRunStep(run(), "g1")).toEqual({ ok: true });
    expect(checkDirectorRunStep(run({ expectedBaseline: "g1", round: 1, stepCount: 1 }), "g1")).toEqual({ ok: true });
    // One review per round: a second tab cannot add another before a shot moves the run on.
    expect(checkDirectorRunStep(run({ stepCount: 1 }), "g1")).toMatchObject({ ok: false, reason: "reviewed" });
    expect(checkDirectorRunStep(run({ expectedBaseline: "g1" }), "g2")).toMatchObject({ ok: false, reason: "baseline-mismatch" });
    expect(checkDirectorRunStep(run({ cancelRequested: true }), "g1")).toMatchObject({ ok: false, reason: "stopped" });
    expect(checkDirectorRunStep(run({ stepActive: true }), "g1")).toMatchObject({ ok: false, reason: "busy" });
    expect(checkDirectorRunStep(run({ status: "SUCCEEDED" }), "g1")).toMatchObject({ ok: false, reason: "finished" });
  });

  it("counts rounds and credits and refuses to pass the budget", () => {
    expect(advanceDirectorRun(run(), { credits: 2, nextBaseline: "g2" })).toEqual({ ok: true, round: 1, spentCredits: 2, expectedBaseline: "g2" });
    expect(advanceDirectorRun(run({ spentCredits: 2 }), { credits: 2, nextBaseline: "g2" })).toMatchObject({ ok: false });
    expect(advanceDirectorRun(run({ round: 4 }), { credits: 1, nextBaseline: "g2" })).toMatchObject({ ok: false });
    expect(advanceDirectorRun(run({ cancelRequested: true }), { credits: 1, nextBaseline: "g2" })).toMatchObject({ ok: false });
  });
});
