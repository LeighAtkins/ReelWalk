import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatShotElapsed, ShotGenerationProgress, shotProgressSummary } from "./shot-generation-progress";

describe("honest generation progress", () => {
  const start = "2026-11-15T10:00:00.000Z", timestamp = Date.parse(start);

  it("formats total elapsed request time across reloads, hour boundaries and clock skew", () => {
    expect(formatShotElapsed(start, timestamp + 65_999)).toBe("1:05");
    expect(formatShotElapsed(start, timestamp + 3_661_000)).toBe("1:01:01");
    expect(formatShotElapsed(start, timestamp - 1000)).toBe("0:00");
    expect(formatShotElapsed(undefined, timestamp)).toBeNull();
    expect(formatShotElapsed("unavailable", timestamp)).toBeNull();
    expect(formatShotElapsed(start, NaN)).toBeNull();
  });

  it("distinguishes queued work, uncertain outcomes and disconnected polling without claiming provider completion", () => {
    expect(shotProgressSummary({ stage: "video", status: "QUEUED", queueLabel: "Queued · 2 ahead" })).toMatchObject({ active: true, detail: "Queued · 2 ahead" });
    for (const status of ["UNKNOWN", "UNRESOLVED"]) {
      const state = shotProgressSummary({ stage: "end", status });
      expect(state).toMatchObject({ active: false, attention: true, terminal: false });
      expect(state.detail).toContain("will not be submitted again automatically");
    }
    expect(shotProgressSummary({ stage: "video", status: "RUNNING", connectionError: "Progress could not refresh" })).toMatchObject({ title: "Connection interrupted", active: false, attention: true });
    expect(shotProgressSummary({ stage: "start", status: "FAILED" })).toMatchObject({ active: false, attention: true, terminal: true });
  });

  it("does not animate or invent progress when no active status exists", () => {
    expect(shotProgressSummary({ stage: "start" }).active).toBe(false);
    expect(shotProgressSummary({ stage: "end", status: "CANDIDATE" })).toMatchObject({ active: false, terminal: true });
    expect(shotProgressSummary({ stage: "review" })).toMatchObject({ title: "Review Start and End", terminal: true });
    expect(shotProgressSummary({ stage: "ready" })).toMatchObject({ title: "Your video is ready", terminal: true });
  });

  it("separates phase announcements from a non-announcing elapsed timer and makes no network request", () => {
    vi.useFakeTimers(); vi.setSystemTime(timestamp + 65_000);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      const html = renderToStaticMarkup(createElement(ShotGenerationProgress, { stage: "end", status: "SUBMITTING", requestedAt: start }));
      expect(html).toContain('role="status" aria-live="polite">Preparing End frame');
      expect(html).toContain('role="timer" aria-live="off" aria-label="Elapsed since request">Elapsed 1:05');
      expect(html).not.toContain("progressbar");
      expect(html).not.toMatch(/\d+%/);
      expect(fetch).not.toHaveBeenCalled();
      const terminal = renderToStaticMarkup(createElement(ShotGenerationProgress, { stage: "ready", status: "SUCCEEDED", requestedAt: start }));
      expect(terminal).not.toContain('role="timer"');
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
});
