import { describe, expect, it, vi } from "vitest";
import type { CriticSample } from "@reelwalk/core";
import { readCriticFrames, type CriticFrameEntry, type CriticFrameRun } from "./critic-frames";

// Reading the critic's frames (ADR 0062): a failed source costs one try, a slow one one timeout,
// a cancelled run stops drawing, and a run after a fix reads only what is new.

const sample = (clipId: string, sourceMs: number): CriticSample => ({ key: `${clipId}@${sourceMs}`, clipId, sourceMs, reelMs: sourceMs });
const entry = (): CriticFrameEntry => ({ frame: { width: 1, height: 1, luma: new Float32Array([0.5]) }, thumb: null });
const sources: Record<string, string> = { a: "a.mp4", b: "b.mp4", p: "p.jpg" };

function setup(draw: CriticFrameRun<string>["draw"], overrides: Partial<CriticFrameRun<string>> = {}) {
  const run: CriticFrameRun<string> = {
    keyOf: (s) => s.key,
    sourceOf: (s) => sources[s.clipId] ?? null,
    cache: new Map(),
    failed: new Set(),
    draw: vi.fn(draw),
    read: vi.fn(() => entry()),
    live: () => true,
    timeoutMs: 30,
    ...overrides,
  };
  return run;
}

describe("reading the critic's frames", () => {
  it("a source that fails once is skipped for the rest of the run and by the next run", async () => {
    const run = setup(async (s) => (s.clipId === "a" ? null : "canvas"));
    const samples = [sample("a", 0), sample("a", 500), sample("a", 1000), sample("b", 0), sample("b", 500)];
    const result = await readCriticFrames(samples, run);
    expect(result).toEqual({ read: 2, skipped: 2, cancelled: false });
    expect((run.draw as ReturnType<typeof vi.fn>).mock.calls.filter(([s]) => s.clipId === "a")).toHaveLength(1);
    expect(run.failed).toEqual(new Set(["a.mp4"]));
    // A later run (after a fix) sharing the failed set does not try "a" again, and does not redraw what is cached.
    (run.draw as ReturnType<typeof vi.fn>).mockClear();
    const again = await readCriticFrames([...samples, sample("b", 1000)], run);
    expect(again).toEqual({ read: 1, skipped: 3, cancelled: false });
    expect((run.draw as ReturnType<typeof vi.fn>).mock.calls.map(([s]) => s.key)).toEqual(["b@1000"]);
  });

  it("a draw that never answers times out once and gives up on its source", async () => {
    const run = setup((s) => (s.clipId === "p" ? new Promise<string>(() => undefined) : Promise.resolve("canvas")));
    const started = Date.now();
    const result = await readCriticFrames([sample("p", 0), sample("p", 0.5), sample("b", 0)], run);
    expect(result).toEqual({ read: 1, skipped: 1, cancelled: false });
    expect(run.failed.has("p.jpg")).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a canvas that cannot be read back (no CORS) fails its source, not the run", async () => {
    const run = setup(async () => "canvas", { read: vi.fn((canvas: string) => { if (canvas) throw new Error("tainted"); return entry(); }) });
    run.sourceOf = (s) => sources[s.clipId];
    const result = await readCriticFrames([sample("a", 0), sample("a", 500)], run);
    expect(result).toEqual({ read: 0, skipped: 1, cancelled: false });
    expect(run.failed.has("a.mp4")).toBe(true);
  });

  it("stops drawing as soon as the run is cancelled, and stores nothing after", async () => {
    let live = true;
    const run = setup(async () => { live = false; return "canvas"; }, { live: () => live });
    const result = await readCriticFrames([sample("a", 0), sample("a", 500), sample("b", 0)], run);
    expect(result.cancelled).toBe(true);
    expect(run.draw).toHaveBeenCalledTimes(1);
    expect(run.cache.size).toBe(0);
  });

  it("keeps the cache to its cap, oldest first", async () => {
    const run = setup(async () => "canvas", { maxCached: 2 });
    await readCriticFrames([sample("a", 0), sample("a", 500), sample("b", 0)], run);
    expect([...run.cache.keys()]).toEqual(["a@500", "b@0"]);
  });
});
