import { describe, expect, it } from "vitest";
import { AI_HOURLY_SUBMISSIONS, AI_QUEUE_LIMIT, hourlySubmissions, inFlight, isComposing, nextSubmissionSlot, queueDecision, queueLabel, queuePosition, type QueueRow } from "../src/take-queue";

const now = new Date("2026-10-22T10:00:00Z");
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
const row = (id: string, status: string, createdMinutesAgo: number, extra: Partial<QueueRow> = {}): QueueRow =>
  ({ id, status, createdAt: at(createdMinutesAgo), submitStartedAt: null, leaseUntil: null, ...extra });

describe("the take queue (ADR 0069)", () => {
  it("allows the owner-approved 20 submissions per hour while retaining the hourly fence", () => {
    const sent = Array.from({ length: 20 }, (_, i) => row(`sent-${i}`, "SUCCEEDED", 30, { submitStartedAt: at(30) }));
    const waiting = row("next", "QUEUED", 1);
    expect(queueDecision([...sent.slice(0, 10), waiting], now).nextId).toBe("next");
    expect(queueDecision([...sent.slice(0, 19), waiting], now).nextId).toBe("next");
    expect(queueDecision([...sent, waiting], now)).toEqual({ nextId: null, blockedBy: "hour", slotAt: at(-30) });
    expect(queueDecision([...sent, waiting], at(-31)).nextId).toBe("next");
  });
  it("starts the oldest queued take first", () => {
    const rows = [row("b", "QUEUED", 2), row("a", "QUEUED", 5), row("c", "QUEUED", 1)];
    expect(queueDecision(rows, now)).toEqual({ nextId: "a", blockedBy: null, slotAt: null });
    expect(queuePosition(rows, "c", now)).toEqual({ position: 3, waitingFor: "turn", slotAt: null });
    expect(queuePosition(rows, "a", now)).toEqual({ position: 1, waitingFor: null, slotAt: null });
    expect(queuePosition(rows, "zzz", now)).toBeNull();
  });

  it("composes one take at a time per workspace: nothing starts while another is being composed under a live lease", () => {
    const composing = row("x", "SUBMITTING", 3, { leaseUntil: new Date(now.getTime() + 60_000) });
    const rows = [composing, row("a", "QUEUED", 2)];
    expect(isComposing(composing, now)).toBe(true);
    expect(queueDecision(rows, now)).toEqual({ nextId: null, blockedBy: "compose", slotAt: null });
    expect(queuePosition(rows, "a", now)).toEqual({ position: 1, waitingFor: "compose", slotAt: null });
    // A lapsed lease is a dead worker, not a compose in progress; one past the fence is with Veo, not composing.
    expect(isComposing(row("x", "SUBMITTING", 3, { leaseUntil: at(1) }), now)).toBe(false);
    expect(isComposing(row("x", "SUBMITTING", 3, { leaseUntil: new Date(now.getTime() + 60_000), submitStartedAt: at(1) }), now)).toBe(false);
    expect(queueDecision([row("x", "SUBMITTING", 3, { leaseUntil: at(1) }), row("a", "QUEUED", 2)], now).nextId).toBe("a");
  });

  it("two takes submitted seconds apart: the second waits its turn, then for the compose, and starts once the first is past the fence", () => {
    const first = row("first", "QUEUED", 1), second = row("second", "QUEUED", 0.9);
    // Both queued: only the older may start.
    expect(queueDecision([first, second], now)).toEqual({ nextId: "first", blockedBy: null, slotAt: null });
    expect(queuePosition([first, second], "second", now)).toEqual({ position: 2, waitingFor: "turn", slotAt: null });
    // The first is claimed and composing under a live lease: the second is next, but held.
    const composing = { ...first, status: "SUBMITTING", leaseUntil: new Date(now.getTime() + 300_000) };
    expect(queueDecision([composing, second], now)).toEqual({ nextId: null, blockedBy: "compose", slotAt: null });
    expect(queuePosition([composing, second], "second", now)).toEqual({ position: 1, waitingFor: "compose", slotAt: null });
    // Past the fence (Veo is being paid, compose is over): the second starts.
    const fenced = { ...composing, submitStartedAt: now };
    expect(queueDecision([fenced, second], now).nextId).toBe("second");
    // Refunded before Veo (a compose failure): the second starts and the failure never counts toward the hour.
    const refunded = { ...first, status: "FAILED" };
    expect(queueDecision([refunded, second], now).nextId).toBe("second");
    expect(hourlySubmissions([refunded, second], now)).toBe(0);
  });

  it("counts only Veo submissions toward the hour: a failure before Veo never counts", () => {
    const failedBeforeVeo = Array.from({ length: 12 }, (_, i) => row(`f${i}`, "FAILED", 30 + i));
    expect(hourlySubmissions(failedBeforeVeo, now)).toBe(0);
    expect(queueDecision([...failedBeforeVeo, row("a", "QUEUED", 1)], now).nextId).toBe("a");
    const sent = Array.from({ length: AI_HOURLY_SUBMISSIONS }, (_, i) => row(`s${i}`, i % 2 ? "SUCCEEDED" : "FAILED", 50 - i, { submitStartedAt: at(50 - i) }));
    expect(hourlySubmissions(sent, now)).toBe(AI_HOURLY_SUBMISSIONS);
    const decision = queueDecision([...sent, row("a", "QUEUED", 1)], now);
    expect(decision.blockedBy).toBe("hour");
    // The oldest submission in the window (50 min ago) leaves it in 10 minutes.
    expect(decision.slotAt?.toISOString()).toBe("2026-10-22T10:10:00.000Z");
    expect(nextSubmissionSlot(sent.slice(1), now)).toBeNull();
    // One submitted 61 minutes ago is outside the window.
    expect(hourlySubmissions([row("old", "SUCCEEDED", 70, { submitStartedAt: at(61) })], now)).toBe(0);
    expect(queuePosition([...sent, row("a", "QUEUED", 1)], "a", now)).toEqual({ position: 1, waitingFor: "hour", slotAt: "2026-10-22T10:10:00.000Z" });
  });

  it("bounds the queue by what is waiting or generating", () => {
    expect(AI_QUEUE_LIMIT).toBe(12);
    expect(inFlight([row("a", "QUEUED", 1), row("b", "RUNNING", 2), row("c", "SUBMITTING", 3), row("d", "SUCCEEDED", 4), row("e", "FAILED", 5)])).toBe(3);
  });

  it("says where a take stands", () => {
    expect(queueLabel(null)).toBe("Waiting to start…");
    expect(queueLabel({ position: 1, waitingFor: null, slotAt: null })).toBe("Next up");
    expect(queueLabel({ position: 3, waitingFor: "turn", slotAt: null })).toBe("Queued · 2 ahead");
    expect(queueLabel({ position: 1, waitingFor: "compose", slotAt: null })).toBe("Next up · another take is being composed");
    expect(queueLabel({ position: 1, waitingFor: "hour", slotAt: "2026-10-22T10:10:00.000Z" })).toBe("Waiting for the hourly limit · opens about 10:10");
  });
});
