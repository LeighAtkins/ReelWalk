import { describe, expect, it } from "vitest";
import type { CriticFrame } from "../src/critic";
import {
  analyseSeries,
  CHECK_SERIES,
  frameNear,
  frameStats,
  judgeTimesMs,
  motionEnergyProfile,
  offBarMs,
  postBlockReason,
  renderChecks,
  RENDER_CHECKS,
  seriesFromGreyFrames,
  titleEntranceMs,
  type FrameSeries,
} from "../src/render-checks";
import { checksKeyFor } from "../src/keys";
import { parseTimeline, type Timeline } from "../src/timeline";

// Verification of a render (ADR 0071): the per-frame facts on synthetic frame sequences, and the hard
// checks that block a post.

const W = 12, H = 21;
/** A textured frame around `luma` (a real picture is never one flat colour). */
const picture = (luma: number, seed = 0): CriticFrame => {
  const frame = { width: W, height: H, luma: new Float32Array(W * H) };
  frame.luma.forEach((_, i) => { frame.luma[i] = Math.min(1, Math.max(0, luma + 0.08 * Math.sin(i * 0.7 + seed))); });
  return frame;
};
const black = (): CriticFrame => ({ width: W, height: H, luma: new Float32Array(W * H).fill(0.01) });
const flat = (luma: number): CriticFrame => ({ width: W, height: H, luma: new Float32Array(W * H).fill(luma) });
/** A picture that moves: the texture shifts with time. */
const moving = (ms: number): CriticFrame => picture(0.5, ms / 60);

/** A dense series at 30 fps from `paint(ms)`. */
const dense = (durationMs: number, paint: (ms: number) => CriticFrame): FrameSeries =>
  Array.from({ length: Math.round(durationMs / (1000 / 30)) }, (_, k) => ({ ms: Math.round((k * 1000) / 30), frame: paint(Math.round((k * 1000) / 30)) }));

function reel(overrides: Record<string, unknown> = {}): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
    ],
    texts: [],
    music: null,
    ...overrides,
  });
}

describe("frame facts", () => {
  it("measures a frame and finds the nearest frame to a time", () => {
    expect(frameStats(flat(0.2))).toEqual({ mean: expect.closeTo(0.2, 5), std: 0, p95: expect.closeTo(0.2, 5) });
    expect(frameStats(picture(0.5)).std).toBeGreaterThan(RENDER_CHECKS.emptyStd);
    const series = dense(1000, moving);
    expect(frameNear(series, 500)?.ms).toBe(500);
    expect(frameNear(series, 510)?.ms).toBe(500);
    expect(frameNear(series, 5000)).toBeNull();
  });

  it("a single black frame between lit frames is a flash; a black opening or a long fade is not", () => {
    const flash = dense(2000, (ms) => (ms === 1000 ? black() : moving(ms)));
    const facts = analyseSeries(flash);
    expect(facts.flashFrames).toEqual([1000]);
    expect(facts.black).toEqual([{ fromMs: 1000, toMs: expect.closeTo(1033, 0), frames: 1 }]);
    expect(facts.openingBlack).toBe(false);
    // Frame 0 black: the opening, not a flash.
    const darkOpen = analyseSeries(dense(1000, (ms) => (ms < 200 ? black() : moving(ms))));
    expect(darkOpen.openingBlack).toBe(true);
    expect(darkOpen.flashFrames).toEqual([]);
    // A second of black in the middle is a fade or a card, not a glitch.
    const fade = analyseSeries(dense(3000, (ms) => (ms >= 1000 && ms < 2000 ? black() : moving(ms))));
    expect(fade.flashFrames).toEqual([]);
    expect(fade.black[0].frames).toBe(30);
  });

  it("a flash at a cut is a glitch; a cut to a dark shot is not", () => {
    const timeline = reel();
    // Black frame just before the cut at 2 s, same clip either side of it in the timeline's eyes: the renderer's black frame.
    const atCut = analyseSeries(dense(4000, (ms) => (ms === 1967 ? black() : moving(ms))), timeline);
    expect(atCut.flashFrames).toEqual([1967]);
    // Clip b is a dark shot altogether: black frames from 2 s on are its picture.
    const darkShot = analyseSeries(dense(4000, (ms) => (ms >= 2000 ? black() : moving(ms))), timeline);
    expect(darkShot.flashFrames).toEqual([]);
  });

  it("an empty frame 0 is one flat colour; frozen frames inside a video shot are reported, a still photo is not", () => {
    expect(analyseSeries(dense(500, () => flat(0.5))).openingEmpty).toBe(true);
    expect(analyseSeries(dense(500, moving)).openingEmpty).toBe(false);
    // Moving for a second, then the same picture for 1.5 s, inside a video clip.
    const frozen = analyseSeries(dense(4000, (ms) => (ms >= 1000 && ms < 2500 ? picture(0.5, 99) : moving(ms))), reel());
    expect(frozen.frozen).toHaveLength(1);
    expect(frozen.frozen[0].fromMs).toBeCloseTo(1000, -1);
    expect(frozen.frozen[0].toMs).toBeCloseTo(2500, -1);
    // The same frames over a photo clip are a photo, not a freeze.
    const photo = reel({ clips: [{ id: "p", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 4000 }] });
    expect(analyseSeries(dense(4000, (ms) => (ms >= 1000 && ms < 2500 ? picture(0.5, 99) : moving(ms))), photo).frozen).toEqual([]);
    // Under a second of the same picture is not reported.
    expect(analyseSeries(dense(4000, (ms) => (ms >= 1000 && ms < 1800 ? picture(0.5, 99) : moving(ms))), reel()).frozen).toEqual([]);
  });

  it("motion energy is measured over half a second, never across a cut, and summed per second", () => {
    const series = dense(4000, (ms) => (ms < 2000 ? picture(0.3) : moving(ms)));
    const profile = motionEnergyProfile(series, 500, [2000]);
    const before = profile.filter((p) => p.ms < 1500);
    const after = profile.filter((p) => p.ms >= 2000 && p.ms < 3400);
    expect(before.every((p) => p.energy < 0.005)).toBe(true);
    expect(after.every((p) => p.energy > 0.02)).toBe(true);
    // The last readings before the cut stop at the cut rather than compare with the next shot.
    const edge = profile.filter((p) => p.ms >= 1500 && p.ms < 2000);
    expect(edge.every((p) => p.toMs === 2000 && p.energy < 0.005)).toBe(true);
    const facts = analyseSeries(series, reel({ clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 }, { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 }] }));
    expect(facts.motionPerSecond).toHaveLength(4);
    expect(facts.motionPerSecond[0]).toBeLessThan(0.005);
    expect(facts.motionPerSecond[2]).toBeGreaterThan(0.02);
    // A sparse series (every 500 ms) measures the same way.
    const sparse = series.filter((f) => f.ms % 500 === 0);
    expect(motionEnergyProfile(sparse).length).toBeGreaterThan(5);
    // A one-second grid still measures (scaled to the half-second span); a gap over about a second does not.
    expect(motionEnergyProfile(series.filter((f) => f.ms % 1000 === 0)).length).toBeGreaterThan(2);
    expect(motionEnergyProfile(series.filter((f) => f.ms % 2000 === 0))).toEqual([]);
  });

  it("the loop seam is the last frame against the first", () => {
    expect(analyseSeries(dense(1000, () => picture(0.5))).loopSeamDiff).toBe(0);
    expect(analyseSeries(dense(1000, (ms) => (ms < 900 ? picture(0.2) : picture(0.8)))).loopSeamDiff).toBeCloseTo(0.6, 1);
  });
});

describe("timeline facts", () => {
  const text = (over: Record<string, unknown>) => reel({ texts: [{ id: "t", text: "Just listed today", startMs: 0, endMs: 3000, ...over }] }).texts[0];

  it("knows how long each entrance takes", () => {
    expect(titleEntranceMs(text({}))).toBe(100); // pop
    expect(titleEntranceMs(text({ style: "elegant" }))).toBe(600); // the elegant fade
    expect(titleEntranceMs(text({ animation: "rise" }))).toBe(500);
    expect(titleEntranceMs(text({ animation: "none" }))).toBe(0);
    expect(titleEntranceMs(text({ animation: "type" }))).toBe(Math.round((17 / 14) * 1000));
    expect(titleEntranceMs(text({ kinetic: { preset: "words" } }))).toBe(900);
    expect(titleEntranceMs(text({ kinetic: { preset: "count", startMs: 100, durationMs: 400 } }))).toBe(500);
  });

  it("measures the ending against the song's bars", () => {
    expect(offBarMs(reel())).toBeNull();
    // 120 bpm: a bar is 2 s. A 4 s reel ends on a bar; 4.3 s is 300 ms off.
    expect(offBarMs(reel({ music: { assetId: "s", bpm: 120, beatOffsetMs: 0 } }))).toBe(0);
    const off = reel({ clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4300 }], music: { assetId: "s", bpm: 120, beatOffsetMs: 0 } });
    expect(offBarMs(off)).toBe(300);
  });
});

describe("the checks", () => {
  it("block on a flash frame, an empty opening and a title under the buttons; everything else warns", () => {
    const timeline = reel({
      texts: [
        { id: "right", text: "Open house Saturday afternoon", startMs: 500, endMs: 2500, x: 0.9, y: 0.5 },
        { id: "top", text: "Hello", startMs: 500, endMs: 2500, x: 0.5, y: 0.03 },
      ],
      music: { assetId: "s", bpm: 100, beatOffsetMs: 0 },
    });
    const series = dense(4000, (ms) => (ms === 0 ? flat(0.5) : ms === 1000 ? black() : moving(ms)));
    const checks = renderChecks({ timeline, series });
    expect(checks.blocked).toBe(true);
    expect(checks.checks.filter((c) => c.level === "block").map((c) => c.id)).toEqual(["empty-opening", "black-frame:1000", "title-under-buttons:right"]);
    expect(checks.checks.find((c) => c.id === "title-in-zone:top")?.level).toBe("warn");
    expect(checks.checks.find((c) => c.id === "off-bar")?.level).toBe("warn"); // 4 s at 100 bpm is 1.67 bars
    expect(checks.facts.zoneReach.map((r) => r.textId).sort()).toEqual(["right", "top"]);
    expect(checks.facts.motionPerSecond).toHaveLength(4);
    expect(postBlockReason(checks)).toMatch(/^Frame 0 is one flat colour.*\(2 more problems\.\)$/);
    expect(checks.audio).toEqual({ available: false, problems: [] });
  });

  it("a clean render passes, and says what was measured", () => {
    const timeline = reel({ texts: [{ id: "t", text: "Hello", startMs: 0, endMs: 2000, y: 0.4 }], music: { assetId: "s", bpm: 120, beatOffsetMs: 0 } });
    const checks = renderChecks({ timeline, series: dense(4000, moving) });
    expect(checks.blocked).toBe(false);
    expect(checks.checks).toEqual([]);
    expect(checks.facts.frames).toEqual({ count: 120, stepMs: 33 });
    expect(checks.facts.titleLegibleByMs).toBe(100);
    expect(checks.facts.offBarMs).toBe(0);
    expect(postBlockReason(checks)).toBeNull();
  });

  it("without frames the timeline checks still run and the frame facts say so", () => {
    const timeline = reel({ texts: [{ id: "slow", text: "Welcome home", startMs: 100, endMs: 3000, style: "elegant", y: 0.4 }] });
    const checks = renderChecks({ timeline });
    expect(checks.facts.frames).toBeNull();
    expect(checks.facts.openingBlack).toBeNull();
    expect(checks.facts.loopSeamDiff).toBeNull();
    expect(checks.checks.map((c) => c.id)).toEqual(["slow-opening-title:slow"]);
    expect(checks.facts.titleLegibleByMs).toBe(700);
    expect(checks.blocked).toBe(false);
  });

  it("a loop that jumps and a frozen shot warn; audio problems pass through at their own level", () => {
    const timeline = reel();
    const series = dense(4000, (ms) => (ms < 1000 ? picture(0.1) : ms < 2000 ? picture(0.5, 7) : moving(ms) ));
    const checks = renderChecks({ timeline, series, audio: [{ id: "clipped", level: "block", title: "Clipping", detail: "The voice clips at 3.1 s.", atMs: 3100 }] });
    const ids = checks.checks.map((c) => c.id);
    expect(ids).toContain("loop-seam");
    expect(ids.some((id) => id.startsWith("frozen:"))).toBe(true);
    expect(checks.checks.find((c) => c.id === "audio:clipped")).toMatchObject({ level: "block", impact: "finish" });
    expect(checks.blocked).toBe(true);
    expect(checks.audio.available).toBe(true);
  });

  it("the hook planner's facts, when given, replace the frame reading", () => {
    const timeline = reel({ texts: [{ id: "t", text: "Hello", startMs: 0, endMs: 2000, style: "elegant", y: 0.4 }] });
    const checks = renderChecks({ timeline, series: dense(1000, (ms) => (ms === 0 ? flat(0.5) : moving(ms))), hook: { openingEmpty: false, titleLegibleByMs: 250 } });
    expect(checks.checks).toEqual([]);
    expect(checks.facts.titleLegibleByMs).toBe(250);
  });
});

describe("the render's decode and the Judge moments", () => {
  it("reads ffmpeg's raw grey stream as frames on the frame grid, dropping a partial tail", () => {
    const w = 4, h = 3, size = w * h;
    const bytes = new Uint8Array(size * 2 + 5);
    bytes.fill(0, 0, size);
    bytes.fill(255, size, size * 2);
    const series = seriesFromGreyFrames(bytes, w, h, 30);
    expect(series.map((f) => f.ms)).toEqual([0, 33]);
    expect(series[0].frame).toMatchObject({ width: w, height: h });
    expect(Array.from(series[0].frame.luma)).toEqual(new Array(size).fill(0));
    expect(Array.from(series[1].frame.luma)).toEqual(new Array(size).fill(1));
    expect(seriesFromGreyFrames(new Uint8Array(0)).length).toBe(0);
    expect(CHECK_SERIES).toEqual({ width: 72, height: 128, fps: 30 });
  });

  it("names the opening and the last 1.5 s, on frames, without repeating a moment on a short reel", () => {
    expect(judgeTimesMs(30_000)).toEqual({ opening: [0, 500, 1000, 1500], ending: [28467, 28967, 29467, 29967] });
    const short = judgeTimesMs(2_000);
    expect(short.opening).toEqual([0, 500, 1000, 1500]);
    expect(short.ending).toEqual([1967]);
    expect(judgeTimesMs(0)).toEqual({ opening: [0], ending: [] });
  });

  it("keeps the checks beside the export, one per output key", () => {
    expect(checksKeyFor("renders/job1.mp4")).toBe("renders/job1.checks.json");
    expect(checksKeyFor("renders/job1-2.mp4")).toBe("renders/job1-2.checks.json");
  });
});
