import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isActive, isTerminal, RENDER_JOB_STATUSES, sourcesFor } from "../src";

describe("render job status transitions", () => {
  it("allows the happy path", () => {
    expect(canTransition("QUEUED", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "SUCCEEDED")).toBe(true);
  });

  it("allows automatic retry, final failure and manual retry", () => {
    expect(canTransition("RUNNING", "QUEUED")).toBe(true);
    expect(canTransition("RUNNING", "FAILED")).toBe(true);
    expect(canTransition("FAILED", "QUEUED")).toBe(true);
  });

  it("never leaves SUCCEEDED", () => {
    for (const to of RENDER_JOB_STATUSES) {
      expect(canTransition("SUCCEEDED", to)).toBe(false);
    }
  });

  it("rejects skipping the worker", () => {
    expect(canTransition("QUEUED", "SUCCEEDED")).toBe(false);
    expect(canTransition("FAILED", "RUNNING")).toBe(false);
    expect(canTransition("FAILED", "SUCCEEDED")).toBe(false);
    expect(() => assertTransition("QUEUED", "SUCCEEDED")).toThrow(/Illegal render job transition/);
  });

  it("lists the statuses a transition may start from", () => {
    expect(sourcesFor("QUEUED")).toEqual(["RUNNING", "FAILED"]);
    expect(sourcesFor("SUCCEEDED")).toEqual(["RUNNING"]);
  });

  it("classifies terminal and active statuses", () => {
    expect(isTerminal("SUCCEEDED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    expect(isActive("QUEUED")).toBe(true);
    expect(isActive("RUNNING")).toBe(true);
  });
});
