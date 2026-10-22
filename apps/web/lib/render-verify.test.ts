import { afterEach, describe, expect, it } from "vitest";
import type { RenderChecks } from "@reelwalk/core";
import {
  audioProblemsFrom,
  cacheDirFor,
  ensureChecks,
  frameArgs,
  frameFileName,
  gateFor,
  judgeTimesParam,
  parseStoredChecks,
  parseTimes,
  parseWidth,
  postAnywayLine,
  setFfmpeg,
  VERIFY,
  withAudio,
  type VerifyDeps,
} from "./render-verify";

// The verification routes' pure parts (ADR 0071): what `t=` and `w=` mean, ffmpeg's arguments, the
// cache's names, the stored checks' shape, the Post gate and the audio trace's problems.

const checks = (over: Partial<RenderChecks> = {}): RenderChecks => ({
  version: 1,
  durationMs: 10_000,
  facts: { frames: { count: 300, stepMs: 33 }, black: [], flashFrames: [], openingBlack: false, openingEmpty: false, frozen: [], loopSeamDiff: 0.01, motion: [], motionPerSecond: [], offBarMs: null, titleLegibleByMs: null, zoneReach: [] },
  checks: [],
  blocked: false,
  blockReasons: [],
  audio: { available: false, problems: [] },
  ...over,
});

const blocked = checks({
  checks: [{ id: "black-frame:3000", level: "block", impact: "hold", atMs: 3000, title: "Black frame", detail: "A black frame at 3.00 s between lit frames: the picture drops out for a moment." }],
  blocked: true,
  blockReasons: ["A black frame at 3.00 s between lit frames: the picture drops out for a moment."],
});

function deps(stored: Record<string, unknown> = {}) {
  const puts: { key: string; value: unknown }[] = [];
  const downloads: string[] = [];
  const d: VerifyDeps = {
    cacheRoot: "/tmp/verify-test",
    download: async (key) => { downloads.push(key); },
    readJson: async (key) => stored[key] ?? null,
    putJson: async (key, value) => { puts.push({ key, value }); },
  };
  return { d, puts, downloads };
}

afterEach(() => setFfmpeg(undefined));

describe("times and width", () => {
  it("reads seconds or ms, snaps to the frame grid, keeps order, drops repeats, clamps into the reel", () => {
    expect(parseTimes("0,0.5,1.5", 30_000)).toEqual([0, 500, 1500]);
    expect(parseTimes("1500ms, 1.5, 0.51", 30_000)).toEqual([1500, 500]);
    expect(parseTimes("40", 30_000)).toEqual([29967]);
    expect(parseTimes("-0.5,end,last", 30_000)).toEqual([29467, 29967]);
    expect(parseTimes("x,,", 30_000)).toEqual([]);
    expect(parseTimes(null, 30_000)).toEqual([]);
    expect(parseTimes(Array.from({ length: 40 }, (_, i) => i).join(","), 60_000)).toHaveLength(VERIFY.maxTimes);
  });

  it("widths are even, between 54 and 1080, 270 by default", () => {
    expect(parseWidth(null)).toBe(270);
    expect(parseWidth("271")).toBe(272);
    expect(parseWidth("10")).toBe(54);
    expect(parseWidth("5000")).toBe(1080);
    expect(parseWidth("abc")).toBe(270);
  });
});

describe("ffmpeg and the cache", () => {
  it("cuts one frame after an input seek, scaled to the width, as a JPEG on stdout", () => {
    const args = frameArgs("/cache/render.mp4", 1500, 270);
    expect(args.slice(0, 7)).toEqual(["-v", "error", "-nostdin", "-ss", "1.490", "-i", "/cache/render.mp4"]);
    expect(frameArgs("/cache/render.mp4", 0, 270)[4]).toBe("0.000");
    expect(args).toContain("scale=270:-2");
    expect(args.slice(-3)).toEqual(["-vcodec", "mjpeg", "-"]);
  });

  it("names cache entries by a hash of the key, and frames by time and width", () => {
    const dir = cacheDirFor("/tmp/v", "renders/job1.mp4");
    expect(dir.replace(/\\/g, "/")).toMatch(/^\/tmp\/v\/[0-9a-f]{16}$/);
    expect(cacheDirFor("/tmp/v", "renders/job1.mp4")).toBe(dir);
    expect(cacheDirFor("/tmp/v", "renders/job1-2.mp4")).not.toBe(dir);
    expect(frameFileName(1500, 270)).toBe("f-1500-270.jpg");
  });
});

describe("stored checks and the gate", () => {
  it("accepts this module's shape only", () => {
    expect(parseStoredChecks(checks())).not.toBeNull();
    expect(parseStoredChecks({ version: 2, checks: [] })).toBeNull();
    expect(parseStoredChecks("{}")).toBeNull();
    expect(parseStoredChecks(null)).toBeNull();
  });

  it("gates on the stored verdict, and not at all without checks", () => {
    expect(gateFor(null)).toEqual({ blocked: false, reason: null, reasons: [], checked: false });
    expect(gateFor(checks())).toMatchObject({ blocked: false, reason: null, checked: true });
    const gate = gateFor(blocked);
    expect(gate.blocked).toBe(true);
    expect(gate.reason).toContain("black frame");
    expect(gate.reasons).toEqual(blocked.blockReasons);
  });

  it("serves what the worker stored without touching the file", async () => {
    const { d, downloads } = deps({ "renders/job1.checks.json": blocked });
    const result = await ensureChecks({ output: { objectKey: "renders/job1.mp4" }, payload: null }, { deps: d });
    expect(result.source).toBe("stored");
    expect(result.checks?.blocked).toBe(true);
    expect(downloads).toEqual([]);
  });

  it("without stored checks: none when asked not to compute, none without ffmpeg, none for an unfinished export", async () => {
    setFfmpeg(null);
    const { d } = deps();
    expect(await ensureChecks({ output: { objectKey: "renders/job1.mp4" }, payload: null }, { deps: d, compute: false })).toMatchObject({ checks: null, source: "none" });
    const none = await ensureChecks({ output: { objectKey: "renders/job1.mp4" }, payload: null }, { deps: d });
    expect(none.checks).toBeNull();
    expect(none.reason).toContain("ffmpeg");
    expect(await ensureChecks({ output: null, payload: null }, { deps: d })).toMatchObject({ checks: null, reason: "This export has not finished." });
  });

  it("`fresh` ignores what is stored", async () => {
    setFfmpeg(null);
    const { d } = deps({ "renders/job1.checks.json": blocked });
    expect((await ensureChecks({ output: { objectKey: "renders/job1.mp4" }, payload: null }, { deps: d, fresh: true })).checks).toBeNull();
  });

  it("logs a post made against the gate as one JSON line", () => {
    expect(JSON.parse(postAnywayLine({ jobId: "j1", userId: "u1", action: "post", reasons: ["a"] }))).toEqual({ event: "post-anyway", action: "post", jobId: "j1", userId: "u1", reasons: ["a"] });
  });
});

describe("the audio trace", () => {
  it("reads a list of problems in either shape and ignores anything else", () => {
    expect(audioProblemsFrom(null)).toBeNull();
    expect(audioProblemsFrom({ ok: true })).toBeNull();
    expect(audioProblemsFrom({ problems: [] })).toEqual([]);
    expect(audioProblemsFrom({ issues: [{ id: "silence", severity: "high", summary: "Silence", reason: "1.4 s of silence at 3 s", atMs: 3000 }, { nope: true }] })).toEqual([
      { id: "silence", level: "block", title: "Silence", detail: "1.4 s of silence at 3 s", atMs: 3000 },
    ]);
    expect(audioProblemsFrom([{ id: "quiet", level: "warn", title: "Quiet", detail: "Under -20 LUFS" }])).toEqual([{ id: "quiet", level: "warn", title: "Quiet", detail: "Under -20 LUFS" }]);
  });

  it("folds the problems into stored checks, blocks first, and marks the sound as checked", () => {
    const merged = withAudio(checks(), [{ id: "silence", level: "block", title: "Silence", detail: "1.4 s of silence at 3 s", atMs: 3000 }, { id: "quiet", level: "warn", title: "Quiet", detail: "Under -20 LUFS" }]);
    expect(merged.audio.available).toBe(true);
    expect(merged.checks.map((check) => [check.id, check.level, check.impact])).toEqual([["audio:silence", "block", "hold"], ["audio:quiet", "warn", "hold"]]);
    expect(merged.blocked).toBe(true);
    expect(withAudio(checks(), null)).toEqual(checks());
    // Merging again replaces the sound's checks rather than adding to them.
    expect(withAudio(merged, []).checks).toEqual([]);
  });
});

describe("the Judge view", () => {
  it("asks for the opening and the last 1.5 s in one `t=`", () => {
    expect(judgeTimesParam(30_000)).toBe("0ms,500ms,1000ms,1500ms,28467ms,28967ms,29467ms,29967ms");
  });
});
