import { describe, expect, it } from "vitest";
import {
  applyCommand, classify, defaultSpeedRamp, framePlan, parseTimeline, planSpeedRamps, resolveStreak, speedRampSchema, suggestMatchCuts, whipDirectionFor, matchCutScore,
  SPEED_RAMP_BLUR_PX, SPEED_RAMP_ZOOM_SPREAD, edgeSampleTimes, EDGE_WINDOW_MS,
  type Clip, type ClipMotion, type MotionRead, type ReelClipInput, type Timeline,
} from "../src";

const FPS = 30;
const video = (id: string, sourceStartMs: number, sourceEndMs: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, assetId: `asset-${id}`, kind: "VIDEO", sourceStartMs, sourceEndMs, speed: 1, volume: 1, fit: "cover", filter: "none", motion: "none", pano: null, spot: null, room: null, transitionIn: "cut", zoom: 1, ...extra }) as Clip;
const reel = (clips: Clip[]): Timeline => parseTimeline({ version: 1, clips, texts: [], music: null });
function inputs(timeline: Timeline): ReelClipInput[] {
  return framePlan(timeline, FPS).clips.map(({ clip, durationInFrames }) => ({ clip, durationInFrames, sourceDurationMs: 30000 }));
}
const read = (rates: Partial<Parameters<typeof classify>[0]>): MotionRead => classify({ tx: 0, ty: 0, zoom: 0, rotate: 0, ...rates });
const motion = (start: MotionRead, end: MotionRead): ClipMotion => ({ start: { dx: start.tx * 48, dy: start.ty * 48 }, end: { dx: end.tx * 48, dy: end.ty * 48 }, subject: null, energy: 0.4, startRead: start, endRead: end });

const PUSH = read({ zoom: 0.3 });
const PAN = read({ tx: 0.08 });
const TILT = read({ ty: -0.1 });
const STILL = read({});

describe("the zoom direction (ADR 0074)", () => {
  it("is a direction a speed ramp accepts, and the default is unchanged", () => {
    expect(speedRampSchema.parse({ direction: "zoom" }).direction).toBe("zoom");
    expect(defaultSpeedRamp().direction).toBe("auto");
    expect(SPEED_RAMP_ZOOM_SPREAD).toBeGreaterThan(0);
  });

  it("is a zoom blur from the middle for a footage with no reading, and from the vanishing point for a push", () => {
    expect(resolveStreak("zoom", undefined)).toMatchObject({ kind: "zoom", focus: { x: 0.5, y: 0.5 }, axis: { x: 0, y: 0 } });
    expect(resolveStreak("zoom", undefined, { kind: "pan-x" })).toMatchObject({ kind: "zoom", focus: { x: 0.5, y: 0.5 } });
    expect(resolveStreak("zoom", undefined, { kind: "zoom-in", focus: { x: 0.3, y: 0.6 } })).toMatchObject({ kind: "zoom", focus: { x: 0.3, y: 0.6 } });
  });
});

describe("auto follows what the footage does", () => {
  it("maps push and pull to zoom, a pan to horizontal and a tilt to vertical, with the reason", () => {
    expect(resolveStreak("auto", undefined, { kind: "zoom-in" })).toMatchObject({ kind: "zoom", why: "forward move → zoom" });
    expect(resolveStreak("auto", undefined, { kind: "zoom-out", focus: { x: 0.4, y: 0.5 } })).toMatchObject({ kind: "zoom", focus: { x: 0.4, y: 0.5 }, why: "backward move → zoom" });
    expect(resolveStreak("auto", undefined, { kind: "pan-x" })).toMatchObject({ kind: "horizontal", axis: { x: 1, y: 0 }, why: "sideways pan → horizontal" });
    expect(resolveStreak("auto", undefined, { kind: "pan-y" })).toMatchObject({ kind: "vertical", axis: { x: 0, y: 1 }, why: "tilt → vertical" });
  });

  it("keeps the older behaviour for a roll, a shot that does not move and a footage with no reading", () => {
    expect(resolveStreak("auto", undefined, { kind: "rotate" })).toMatchObject({ kind: "horizontal", why: "roll → horizontal" });
    expect(resolveStreak("auto", "up", { kind: "still" })).toMatchObject({ kind: "vertical", why: "no clear movement → the whip direction" });
    expect(resolveStreak("auto", "up")).toMatchObject({ kind: "vertical", why: expect.stringContaining("whip direction") });
    expect(resolveStreak("auto", undefined)).toMatchObject({ kind: "horizontal", axis: { x: 1, y: 0 } });
  });

  it("leaves an explicit direction alone, whatever the footage does", () => {
    expect(resolveStreak("left", undefined, { kind: "zoom-in" })).toMatchObject({ kind: "horizontal", why: "as asked" });
    expect(resolveStreak("up", undefined, { kind: "zoom-in" })).toMatchObject({ kind: "vertical" });
    expect(resolveStreak(45, undefined, { kind: "zoom-in" }).axis.x).toBeCloseTo(0.707, 3);
    expect(resolveStreak("none", undefined, { kind: "zoom-in" })).toMatchObject({ kind: "none", axis: { x: 0, y: 0 }, focus: null });
  });
});

describe("a speed-ramp cut planned from the footage", () => {
  const timeline = (footage: Clip["rampFootage"], direction: "auto" | "zoom" | "left" = "auto", whip?: Clip["whipDirection"]) =>
    reel([video("a", 4000, 6000), video("b", 4000, 6000, { transitionIn: "speedRamp", speedRamp: { ...defaultSpeedRamp(), direction }, rampFootage: footage, whipDirection: whip })]);

  it("blurs the two sides separately: a push going out streaks from its focus, a pan coming in streaks along it", () => {
    const plan = planSpeedRamps(inputs(timeline({ after: "a", out: { kind: "zoom-in", focus: { x: 0.35, y: 0.55 } }, in: { kind: "pan-x" } })), FPS);
    const [cut] = plan.cuts;
    expect(cut.blur.out).toEqual({ kind: "zoom", why: "forward move → zoom" });
    expect(cut.blur.in).toEqual({ kind: "horizontal", why: "sideways pan → horizontal" });
    expect(cut.note).toContain("Blur: outgoing forward move → zoom; incoming sideways pan → horizontal.");
    const tail = plan.clips.get("a")!, head = plan.clips.get("b")!;
    const last = tail.frames - 1;
    // The outgoing side draws a zoom blur (the spread follows the speed curve exactly as the axis blur does) and no axis blur.
    expect(tail.zoom[last]).toBeCloseTo(defaultSpeedRamp().blur * SPEED_RAMP_ZOOM_SPREAD, 9);
    expect(tail.blurX.every((v) => v === 0) && tail.blurY.every((v) => v === 0)).toBe(true);
    expect([tail.focusX[last], tail.focusY[last]]).toEqual([0.35, 0.55]);
    expect(tail.zoom[0]).toBe(0);
    // The incoming side is the axis blur, as before.
    expect(head.blurX[0]).toBeCloseTo(defaultSpeedRamp().blur * SPEED_RAMP_BLUR_PX, 9);
    expect(head.zoom.every((v) => v === 0)).toBe(true);
  });

  it("gives the zoom blur the same curve as the axis blur: nothing at the start of the ramp, strongest on the cut, the same ratio frame to frame", () => {
    const zoom = planSpeedRamps(inputs(timeline(undefined, "zoom")), FPS).clips.get("a")!;
    const axis = planSpeedRamps(inputs(timeline(undefined, "left")), FPS).clips.get("a")!;
    for (let f = 0; f < zoom.frames; f++) {
      if (axis.blurX[f] === 0) { expect(zoom.zoom[f]).toBe(0); continue; }
      expect(zoom.zoom[f] / axis.blurX[f]).toBeCloseTo(SPEED_RAMP_ZOOM_SPREAD / SPEED_RAMP_BLUR_PX, 9);
    }
    // Push, speed and source frames are not touched by the kind of blur.
    expect(zoom.push).toEqual(axis.push);
    expect(zoom.position).toEqual(axis.position);
    expect(zoom.rate).toEqual(axis.rate);
  });

  it("is a zoom blur on both sides for an explicit zoom direction, from the middle", () => {
    const plan = planSpeedRamps(inputs(timeline(undefined, "zoom")), FPS);
    expect(plan.cuts[0].blur).toEqual({ out: { kind: "zoom", why: "zoom blur as asked" }, in: { kind: "zoom", why: "zoom blur as asked" } });
    expect(plan.clips.get("b")!.focusX[0]).toBe(0.5);
  });

  it("ignores a reading of an outgoing clip that is no longer the one before (the reel was reordered)", () => {
    const stale = planSpeedRamps(inputs(timeline({ after: "somebody-else", out: { kind: "zoom-in" }, in: { kind: "zoom-in" } })), FPS).cuts[0];
    expect(stale.blur.out.kind).toBe("horizontal");
    expect(stale.blur.in.kind).toBe("zoom");
  });

  it("is exactly as before with no reading: horizontal, or the whip direction", () => {
    const plain = planSpeedRamps(inputs(timeline(undefined)), FPS);
    expect(plain.cuts[0].blur.out.kind).toBe("horizontal");
    expect(plain.clips.get("a")!.zoom.every((v) => v === 0)).toBe(true);
    const whipped = planSpeedRamps(inputs(timeline(undefined, "auto", "up")), FPS);
    expect(whipped.cuts[0].blur.out.kind).toBe("vertical");
    expect(whipped.clips.get("a")!.blurY.at(-1)).toBeGreaterThan(0);
  });

  it("states a plain cut for both sides when it is kept as one", () => {
    const tiny = reel([video("a", 0, 120), video("b", 0, 120, { transitionIn: "speedRamp", rampFootage: { out: { kind: "zoom-in" } } })]);
    const plan = planSpeedRamps(framePlan(tiny, FPS).clips.map(({ clip, durationInFrames }) => ({ clip, durationInFrames, sourceDurationMs: 120 })), FPS);
    if (plan.cuts[0].skipped) expect(plan.cuts[0].blur).toEqual({ out: { kind: "none", why: "kept as a plain cut" }, in: { kind: "none", why: "kept as a plain cut" } });
  });
});

describe("matching the footage records what each side does", () => {
  const timeline = reel([video("a", 0, 2000), video("b", 0, 2000, { transitionIn: "speedRamp" }), video("c", 0, 2000, { transitionIn: "speedRamp" }), video("d", 0, 2000)]);
  const measured = { a: motion(STILL, PUSH), b: motion(PAN, TILT), c: motion(STILL, STILL), d: motion(STILL, STILL) };
  const apply = (command: Parameters<typeof applyCommand>[1], base: Timeline = timeline) => applyCommand(base, command, { generation: 0 });

  it("stores the outgoing clip's last half second and the incoming clip's first on every speed-ramp cut, with the clip they were read from", () => {
    const result = apply({ type: "matchCuts", motion: measured, reorder: false });
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.clips[1].rampFootage).toEqual({ after: "a", out: { kind: "zoom-in", focus: { x: 0.5, y: 0.5 } }, in: { kind: "pan-x" } });
    expect(result.timeline.clips[2].rampFootage).toEqual({ after: "b", out: { kind: "pan-y" }, in: { kind: "still" } });
    expect(result.timeline.clips[3].rampFootage).toBeUndefined();
    // The cut then blurs by what was read.
    const plan = planSpeedRamps(inputs(result.timeline), FPS);
    expect(plan.cuts.map((cut) => [cut.blur.out.kind, cut.blur.in.kind])).toEqual([["zoom", "horizontal"], ["vertical", "vertical"]]); // the second cut's incoming shot holds still, so it follows the whip direction the tilt set
  });

  it("can be told not to, and does nothing for a clip with no reading", () => {
    expect(apply({ type: "matchCuts", motion: measured, reorder: false, ramps: false }).timeline.clips[1].rampFootage).toBeUndefined();
    const older: Record<string, ClipMotion> = { a: { start: { dx: 0, dy: 0 }, end: { dx: 1, dy: 0 }, subject: null, energy: 0.2 }, b: { start: { dx: 0, dy: 0 }, end: { dx: 0, dy: 0 }, subject: null, energy: 0.2 } };
    expect(apply({ type: "matchCuts", motion: older, reorder: false }).timeline.clips[1].rampFootage).toBeUndefined();
  });

  it("refuses a malformed reading, so a batch holding it lands nowhere", () => {
    const bad = { ...measured, a: { ...measured.a, endRead: { kind: "sideways" } } } as unknown as Record<string, ClipMotion>;
    expect(apply({ type: "matchCuts", motion: bad }).rejected).toMatch(/reading/);
  });

  it("sets a whip direction from a slow pan the older still threshold would have missed, and none from a push", () => {
    const slow = read({ tx: 0.05 }); // 2.4 px/s at 48 px wide: under the 5 px/s still threshold
    expect(whipDirectionFor(motion(STILL, slow))).toBe("left");
    expect(whipDirectionFor({ start: { dx: 0, dy: 0 }, end: { dx: slow.tx * 48, dy: 0 }, subject: null, energy: 0.2 })).toBeNull();
    expect(whipDirectionFor(motion(STILL, PUSH))).toBeNull();
    expect(whipDirectionFor(motion(STILL, STILL))).toBeNull();
    expect(whipDirectionFor(motion(STILL, read({ ty: 0.06 })))).toBe("up");
  });

  it("scores a push into a push well, a push into a pull badly, and slow pans that agree as a match", () => {
    expect(matchCutScore(motion(STILL, PUSH), motion(PUSH, STILL))).toBeGreaterThan(0.5);
    expect(matchCutScore(motion(STILL, PUSH), motion(read({ zoom: -0.3 }), STILL))).toBeLessThan(0);
    expect(matchCutScore(motion(STILL, read({ tx: 0.06 })), motion(read({ tx: 0.07 }), STILL))).toBeGreaterThan(0.4);
    expect(matchCutScore(motion(STILL, read({ tx: 0.06 })), motion(read({ tx: -0.07 }), STILL))).toBeLessThan(-0.4);
  });

  it("lists the footage in the suggestions for the speed-ramp cuts only", () => {
    const suggestions = suggestMatchCuts(timeline, measured);
    expect(suggestions.footage.map((entry) => entry.clipId)).toEqual(["b", "c"]);
  });
});

describe("the reading window", () => {
  it("is three frames across the last half second of a clip's tail and the first half second of its head", () => {
    expect(EDGE_WINDOW_MS).toBe(500);
    expect(edgeSampleTimes("tail", 1000, 4000)).toEqual([3500, 3730, 3960]);
    expect(edgeSampleTimes("head", 1000, 4000)).toEqual([1000, 1230, 1460]);
    // A clip shorter than the window reads what it has; a fast clip reads proportionally more source.
    expect(edgeSampleTimes("tail", 0, 300)).toEqual([0, 130, 260]);
    expect(edgeSampleTimes("tail", 0, 4000, 2)).toEqual([3000, 3480, 3960]);
  });
});

describe("the command", () => {
  const timeline = reel([video("a", 4000, 6000), video("b", 4000, 6000)]);
  const apply = (command: Parameters<typeof applyCommand>[1]) => applyCommand(timeline, command, { generation: 0 });

  it("sets a speed ramp with the zoom direction, in either form, and refuses nonsense", () => {
    expect(apply({ type: "setTransition", clipId: "b", transition: "speedRamp", speedRamp: { direction: "zoom" } }).timeline.clips[1].speedRamp).toMatchObject({ direction: "zoom", peak: 4 });
    expect(apply({ type: "setTransition", clipId: "b", transition: { kind: "speedRamp", preset: "punch", direction: "zoom" } }).timeline.clips[1].speedRamp).toMatchObject({ direction: "zoom", peak: 5 });
    expect(apply({ type: "setTransition", clipId: "b", transition: "speedRamp", speedRamp: { direction: "radial" as never } }).rejected).toMatch(/direction/);
  });
});
