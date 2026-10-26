import { describe, expect, it } from "vitest";
import {
  applyCommand,
  clipDurationMs,
  clipSourceFrame,
  emptyTimeline,
  cropWidthShare,
  cutBlurAt,
  entryRamp,
  entrySpeedAt,
  flowNear,
  judgeMotionCut,
  mediaWindow,
  MOTION_CUT,
  parseTimeline,
  rampSpeedAt,
  reelFlow,
  timelineDurationMs,
  withMotionCut,
  withoutMotionCut,
  type Clip,
  type Timeline,
} from "../src";

const video = (id: string, start: number, end: number): Clip => parseTimeline({ ...emptyTimeline(), clips: [{ id, assetId: `a-${id}`, kind: "VIDEO", sourceStartMs: start, sourceEndMs: end }], texts: [] }).clips[0];
const reel = (clips: Clip[]): Timeline => parseTimeline({ ...emptyTimeline(), clips, texts: [] });
const durations = { "a-a": 20_000, "a-b": 20_000 };

describe("judging a motion cut (ADR 0089)", () => {
  it("offers it only when both sides move fast in a direction the eye can follow", () => {
    expect(judgeMotionCut({ dx: 0, dy: 1.6, zoom: 0 }, { dx: 0.1, dy: 1.9, zoom: 0 }).ok).toBe(true);
    expect(judgeMotionCut({ dx: 0, dy: 0, zoom: -0.9 }, { dx: 0, dy: 0, zoom: -1.2 }).ok).toBe(true);
    // A pan resolving into a push down a corridor (reel 1, 12.51 s).
    expect(judgeMotionCut({ dx: 0.8, dy: 0, zoom: 0 }, { dx: 0, dy: 0, zoom: 1.4 }).ok).toBe(true);
  });

  it("refuses slow footage, which is what the retired whip was drawn over", () => {
    const slow = judgeMotionCut({ dx: 0.05, dy: 0, zoom: 0 }, { dx: 0.9, dy: 0, zoom: 0 });
    expect(slow.ok).toBe(false);
    expect(!slow.ok && slow.reason).toMatch(/barely moves/);
    expect(judgeMotionCut({ dx: 0.9, dy: 0, zoom: 0 }, { dx: 0.02, dy: 0.01, zoom: 0 }).ok).toBe(false);
    // Fast enough natively but not ramped past the entry speed the references show.
    expect(judgeMotionCut({ dx: 0.3, dy: 0, zoom: 0 }, { dx: 0.22, dy: 0, zoom: 0 }, { rampFrom: 2.5 }).ok).toBe(false);
  });

  it("refuses moves that go different ways, a push into a pull, and turns", () => {
    expect(judgeMotionCut({ dx: 1, dy: 0, zoom: 0 }, { dx: -1, dy: 0, zoom: 0 }).ok).toBe(false);
    expect(judgeMotionCut({ dx: 1, dy: 0, zoom: 0 }, { dx: 0, dy: 1, zoom: 0 }).ok).toBe(false);
    expect(judgeMotionCut({ dx: 0, dy: 0, zoom: 1 }, { dx: 0, dy: 0, zoom: -1 }).ok).toBe(false);
    expect(judgeMotionCut({ dx: 0, dy: 0, zoom: 1 }, { dx: 1, dy: 0, zoom: 0 }).ok).toBe(false);
    expect(judgeMotionCut({ dx: 1, dy: 0, zoom: 0 }, { dx: 1, dy: 0, zoom: 0 }, { rotateIn: 0.9 }).ok).toBe(false);
  });

  it("reads the flow next to the cut from shot-analysis samples and scales a cropped landscape to the reel's frame", () => {
    const samples = [0, 250, 500, 750, 1000].map((t) => ({ t, flow: { dx: t / 1000, dy: 0, zoom: 0.1 } }));
    expect(flowNear(samples, 1000, "out")!.dx).toBeCloseTo(0.875, 3);
    expect(flowNear(samples, 0, "in")!.dx).toBeCloseTo(0.125, 3);
    expect(flowNear([], 0, "in")).toBeNull();
    expect(cropWidthShare(16 / 9)).toBeCloseTo(0.316, 3);
    expect(cropWidthShare(9 / 16)).toBe(1);
    expect(reelFlow({ dx: 0.3, dy: 0.1, zoom: 0.2 }, 16 / 9).dx).toBeCloseTo(0.948, 2);
    expect(reelFlow({ dx: 0.3, dy: 0.1, zoom: 0.2 }, 16 / 9).zoom).toBe(0.2);
  });
});

describe("the incoming ease-out", () => {
  it("starts at rampFrom and eases to 1× over rampFrames, then stays at 1×", () => {
    expect(entrySpeedAt(0, 2.5, 8)).toBe(2.5);
    expect(entrySpeedAt(4, 2.5, 8)).toBeCloseTo(1.375, 6);
    expect(entrySpeedAt(8, 2.5, 8)).toBe(1);
    const planned = entryRamp(60, 2.5, 8)!;
    // The tail plays at exactly the base speed: the ramp's relative speed there times the clip speed is 1.
    expect(rampSpeedAt(planned.ramp, 0.9) * planned.speed).toBeCloseTo(1, 3);
    expect(rampSpeedAt(planned.ramp, 0) * planned.speed).toBeCloseTo(2.5, 2);
    expect(entryRamp(12, 2.5, 8)).toBeNull();
  });

  it("keeps the clip's length on screen and its media window covering every frame", () => {
    const clip = video("b", 2000, 4000);
    const verdict = judgeMotionCut({ dx: 0, dy: 1, zoom: 0 }, { dx: 0, dy: 1.2, zoom: 0 });
    if (!verdict.ok) throw new Error("expected ok");
    const cut = withMotionCut(clip, verdict, 60, 20_000);
    expect(Math.abs(clipDurationMs(cut) - 2000)).toBeLessThanOrEqual(1);
    expect(cut.transitionIn).toBe("motionCut");
    expect(cut.sourceEndMs).toBeGreaterThan(4000);
    // Every frame's source position lies inside the media window, and the picture never runs backwards.
    let last = -Infinity;
    for (let frame = 0; frame < 60; frame++) {
      const window = mediaWindow(cut, frame, 60, 30);
      const at = clipSourceFrame(cut, frame, 60, 30);
      expect(at).toBeLessThanOrEqual(window.trimAfter);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    // The first frames run about 2.5× the last ones.
    expect(clipSourceFrame(cut, 1, 60, 30) - clipSourceFrame(cut, 0, 60, 30)).toBeGreaterThan(2 * (clipSourceFrame(cut, 59, 60, 30) - clipSourceFrame(cut, 58, 60, 30)));
    // Taking it off gives the clip back at the same length.
    const back = withoutMotionCut(cut);
    expect(back).toMatchObject({ transitionIn: "cut", speed: 1, sourceEndMs: 4000, ramp: null });
    expect(back.motionCut).toBeUndefined();
  });

  it("eases a gentler start when the source has little footage after the clip, and refuses when it has none", () => {
    const clip = video("b", 2000, 4000);
    const verdict = judgeMotionCut({ dx: 0, dy: 1, zoom: 0 }, { dx: 0, dy: 1.2, zoom: 0 });
    if (!verdict.ok) throw new Error("expected ok");
    const tight = withMotionCut(clip, verdict, 60, 4100);
    expect(tight.motionCut!.rampFrom).toBeLessThan(2.5);
    expect(() => withMotionCut(clip, verdict, 60, 4000)).toThrow(/too little footage/);
  });
});

describe("the blur, sized from the real motion", () => {
  const cut = { out: { dx: 0, dy: 1.5, zoom: 0 }, in: { dx: 0, dy: 1.8, zoom: 0 }, rampFrom: 2.5, rampFrames: 8 };

  it("is strongest on the first incoming frame, follows the motion's angle and is gone when the ramp reaches 1×", () => {
    const first = cutBlurAt(cut, "in", 0, 30, 1080)!;
    expect(first).toMatchObject({ kind: "directional", angleDeg: 90 });
    const later = cutBlurAt(cut, "in", 4, 30, 1080)!;
    expect(later.kind === "directional" && first.kind === "directional" && later.sigmaPx < first.sigmaPx).toBe(true);
    expect(cutBlurAt(cut, "in", 8, 30, 1080)).toBeNull();
    expect(cutBlurAt(cut, "in", -1, 30, 1080)).toBeNull();
  });

  it("touches only the outgoing clip's last two frames, more on the last", () => {
    const last = cutBlurAt(cut, "out", 0, 30, 1080)!, before = cutBlurAt(cut, "out", 1, 30, 1080)!;
    expect(last.kind === "directional" && before.kind === "directional" && last.sigmaPx > before.sigmaPx).toBe(true);
    expect(cutBlurAt(cut, "out", 2, 30, 1080)).toBeNull();
  });

  it("is radial for a push or pull, scales with the width, and is capped", () => {
    expect(cutBlurAt({ ...cut, in: { dx: 0, dy: 0, zoom: 1.2 } }, "in", 0, 30, 1080)).toMatchObject({ kind: "zoom", push: true });
    const fast = cutBlurAt({ ...cut, in: { dx: 12, dy: 0, zoom: 0 } }, "in", 0, 30, 1080)!;
    expect(fast.kind === "directional" && fast.sigmaPx).toBe(MOTION_CUT.maxSigmaPx);
    const at720 = cutBlurAt(cut, "in", 0, 30, 720)!, at1080 = cutBlurAt(cut, "in", 0, 30, 1080)!;
    expect(at720.kind === "directional" && at1080.kind === "directional" && at720.sigmaPx / at1080.sigmaPx).toBeCloseTo(720 / 1080, 1);
    // A slow side draws nothing (the gate refuses those cuts anyway).
    expect(cutBlurAt({ ...cut, in: { dx: 0.001, dy: 0, zoom: 0 } }, "in", 3, 30, 1080)).toBeNull();
  });
});

describe("the setMotionCut command", () => {
  const base = reel([video("a", 1000, 3000), video("b", 2000, 4000)]);
  const fast = { out: { dx: 0, dy: 1.5, zoom: 0 }, in: { dx: 0, dy: 1.8, zoom: 0 } };

  it("makes the cut from measured motion without moving any cut or the reel's length", () => {
    const result = applyCommand(base, { type: "setMotionCut", clipId: "b", motion: fast }, { generation: 1, sourceDurationsMs: durations });
    expect(result.rejected).toBeUndefined();
    const clip = result.timeline.clips[1];
    expect(clip.transitionIn).toBe("motionCut");
    expect(clip.motionCut?.in.dy).toBe(1.8);
    expect(Math.abs(timelineDurationMs(result.timeline) - timelineDurationMs(base))).toBeLessThanOrEqual(1);
  });

  it("reads analyses at the cut when no motion is given", () => {
    const samples = (dy: number) => [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3250].map((t) => ({ t, flow: { dx: 0, dy, zoom: 0 } }));
    const result = applyCommand(base, { type: "setMotionCut", clipId: "b", analyses: { "a-a": { samples: samples(0.5), width: 1080, height: 1920 }, "a-b": { samples: samples(0.6), width: 1080, height: 1920 } } }, { generation: 1, sourceDurationsMs: durations });
    expect(result.timeline.clips[1].transitionIn).toBe("motionCut");
  });

  it("refuses slow footage with the reason, and refuses motionCut through setTransition or updateClip", () => {
    const slow = applyCommand(base, { type: "setMotionCut", clipId: "b", motion: { out: { dx: 0.02, dy: 0, zoom: 0 }, in: fast.in } }, { generation: 1, sourceDurationsMs: durations });
    expect(slow.rejected).toMatch(/barely moves/);
    expect(applyCommand(base, { type: "setTransition", clipId: "b", transition: "motionCut" }, { generation: 1 }).rejected).toMatch(/setMotionCut/);
    expect(applyCommand(base, { type: "updateClip", clipId: "b", patch: { transitionIn: "motionCut" } }, { generation: 1 }).rejected).toMatch(/setMotionCut/);
    expect(applyCommand(base, { type: "setTransition", clipId: "b", transition: "whip" as never }, { generation: 1 }).rejected).toMatch(/retired/);
  });

  it("is taken off by another transition or on: false, giving the clip back", () => {
    const made = applyCommand(base, { type: "setMotionCut", clipId: "b", motion: fast }, { generation: 1, sourceDurationsMs: durations }).timeline;
    const dissolved = applyCommand(made, { type: "setTransition", clipId: "b", transition: "fade" }, { generation: 2 }).timeline.clips[1];
    expect(dissolved).toMatchObject({ transitionIn: "fade", speed: 1, sourceEndMs: 4000, ramp: null });
    expect(dissolved.motionCut).toBeUndefined();
    const off = applyCommand(made, { type: "setMotionCut", clipId: "b", on: false }, { generation: 2 }).timeline.clips[1];
    expect(off).toMatchObject({ transitionIn: "cut", speed: 1, sourceEndMs: 4000 });
  });

  it("keeps retired kinds reading as a cut, and a saved motion cut round-tripping", () => {
    const saved = parseTimeline({ ...emptyTimeline(), clips: [{ id: "x", assetId: "a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000, transitionIn: "whip" }, { id: "y", assetId: "a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000, transitionIn: "speedRamp" }], texts: [] });
    expect(saved.clips.map((clip) => clip.transitionIn)).toEqual(["cut", "cut"]);
    const made = applyCommand(base, { type: "setMotionCut", clipId: "b", motion: fast }, { generation: 1, sourceDurationsMs: durations }).timeline;
    expect(parseTimeline(JSON.parse(JSON.stringify(made)))).toEqual(made);
  });
});
