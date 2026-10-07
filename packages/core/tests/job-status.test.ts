import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, exportProgressText, isActive, isTerminal, RENDER_JOB_STATUSES, sourcesFor } from "../src";

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

describe("exportProgressText", () => {
  const start = new Date("2026-10-08T00:00:00Z");
  const at = (s: number) => new Date(start.getTime() + s * 1000);
  it("explains the cold start, then a real queue", () => {
    expect(exportProgressText({ status: "QUEUED", progress: 0, createdAt: start, startedAt: null }, at(20)).phase).toBe("Starting a render machine");
    expect(exportProgressText({ status: "QUEUED", progress: 0, createdAt: start, startedAt: null }, at(300))).toEqual({
      phase: "Waiting for a render slot",
      detail: "Queued 5 min ago",
    });
  });
  it("names the preparation phase and estimates the rest once rendering is under way", () => {
    expect(exportProgressText({ status: "RUNNING", progress: 10, createdAt: start, startedAt: start }, at(120))).toEqual({
      phase: "Preparing your clips",
      detail: "2 min so far",
    });
    expect(exportProgressText({ status: "RUNNING", progress: 50, createdAt: start, startedAt: start }, at(600))).toEqual({
      phase: "Rendering 1080×1920",
      detail: "About 10 min left",
    });
    expect(exportProgressText({ status: "RUNNING", progress: 95, createdAt: start, startedAt: start }, at(600)).detail).toBe("Under a minute left");
  });
});
