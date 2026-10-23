import { describe, expect, it } from "vitest";
import {
  analyseSeries, applyCommand, blurAxis, clipSourceFrame, defaultSpeedRamp, framePlan, intensityOfSpeedRamp, mediaWindow, msToFrame, paceTimeline, parseTimeline, planClipSpeed, planHasFrozenFrame, planSpeedRamps,
  SPEED_RAMP_BLUR_PX, SPEED_RAMP_MAX_DIP, SPEED_RAMP_MIN_PEAK, SPEED_RAMP_PRESETS, speedRampAtIntensity, speedRampHalfFrames, speedRampIntensityAt, speedRampMediaWindow, speedRampPresetOf,
  speedRampSchema, retentionFindings, timelineDurationMs, transformScoreOf, windowShortOfSequence, type Clip, type ClipSpeedPlan, type CriticFrame, type FrameSeries, type ReelClipInput, type Timeline,
} from "../src";

const FPS = 30;
const video = (id: string, sourceStartMs: number, sourceEndMs: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, assetId: `asset-${id}`, kind: "VIDEO", sourceStartMs, sourceEndMs, speed: 1, volume: 1, fit: "cover", filter: "none", motion: "none", pano: null, spot: null, room: null, transitionIn: "cut", zoom: 1, ...extra }) as Clip;
const ramped = (clip: Clip, extra: Partial<Clip> = {}): Clip => ({ ...clip, transitionIn: "speedRamp", ...extra });
const reel = (clips: Clip[]): Timeline => parseTimeline({ version: 1, clips, texts: [], music: null });

/** The inputs `planSpeedRamps` takes for a reel, from its frame plan, with the sources' lengths by clip id. */
function inputs(timeline: Timeline, sources: Record<string, number | null> = {}, speech: string[] = []): ReelClipInput[] {
  return framePlan(timeline, FPS).clips.map(({ clip, durationInFrames }) => ({ clip, durationInFrames, sourceDurationMs: sources[clip.id] ?? null, speech: speech.includes(clip.id) }));
}
const sourceFrames = (clip: Clip, plan: ClipSpeedPlan) => plan.position.map((u) => (u >= 0 && u <= plan.frames ? clipSourceFrame(clip, u, plan.frames, FPS) : u < 0 ? msToFrame(clip.sourceStartMs, FPS) + u * (clip.speed || 1) : clipSourceFrame(clip, plan.frames, plan.frames, FPS) + (u - plan.frames) * (clip.speed || 1)));

describe("speed-ramp parameters", () => {
  it("fills the defaults and refuses values out of range", () => {
    expect(defaultSpeedRamp()).toEqual({ durationMs: 500, peak: 4, blur: 0.6, push: 0.08, direction: "auto" });
    for (const bad of [{ durationMs: 100 }, { durationMs: 900 }, { peak: 1.5 }, { peak: 7 }, { blur: 1.5 }, { push: 0.3 }, { direction: "sideways" }, { direction: 400 }]) {
      expect(speedRampSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(speedRampSchema.parse({ direction: 45 }).direction).toBe(45);
  });
  it("has the two presets and a one-knob intensity that agrees with them", () => {
    expect(SPEED_RAMP_PRESETS.soft).toMatchObject({ peak: 3, durationMs: 400 });
    expect(SPEED_RAMP_PRESETS.punch).toMatchObject({ peak: 5, durationMs: 300 });
    expect(speedRampAtIntensity(0.25)).toMatchObject({ peak: 3, durationMs: 400 });
    expect(speedRampAtIntensity(0.75)).toMatchObject({ peak: 5, durationMs: 300 });
    expect(speedRampAtIntensity(0).peak).toBe(2);
    expect(speedRampAtIntensity(1).peak).toBe(6);
    expect(intensityOfSpeedRamp({ peak: 4 })).toBe(0.5);
    expect(speedRampPresetOf(SPEED_RAMP_PRESETS.punch)).toBe("punch");
    expect(speedRampPresetOf(defaultSpeedRamp())).toBeNull();
    // Every point of the knob is inside the schema.
    for (let i = 0; i <= 20; i++) expect(speedRampSchema.safeParse(speedRampAtIntensity(i / 20)).success).toBe(true);
  });
  it("gives each side half the duration in whole frames", () => {
    expect(speedRampHalfFrames({ durationMs: 500 })).toBe(8);
    expect(speedRampHalfFrames({ durationMs: 300 })).toBe(5);
    expect(speedRampHalfFrames({ durationMs: 200 })).toBe(3);
    expect(speedRampHalfFrames({ durationMs: 800 })).toBe(12);
  });
});

describe("the ramp curve", () => {
  it("builds slowly and ends exactly on the peak", () => {
    const frames = 8;
    const steps = Array.from({ length: frames }, (_, k) => speedRampIntensityAt(k, frames));
    expect(steps[frames - 1]).toBe(1);
    expect(steps[0]).toBeLessThan(0.05);
    steps.forEach((value, k) => { if (k > 0) expect(value).toBeGreaterThan(steps[k - 1]); });
  });
});

describe("a speed-ramp cut with plenty of source on both sides", () => {
  const timeline = reel([video("a", 4000, 6000), ramped(video("b", 4000, 6000), { speedRamp: defaultSpeedRamp() }), video("c", 4000, 6000)]);
  const plan = planSpeedRamps(inputs(timeline, { a: 20000, b: 20000, c: 20000 }), FPS);
  const out = plan.clips.get("a")!, into = plan.clips.get("b")!;

  it("lands the peak exactly on the cut, on both sides", () => {
    expect(out.rate[out.frames - 1]).toBeCloseTo(4, 9);
    expect(into.rate[0]).toBeCloseTo(4, 9);
    expect(into.rate[into.frames - 1]).toBe(1);
    expect(plan.cuts[0]).toMatchObject({ peak: 4, requestedPeak: 4, skipped: false });
  });
  it("accelerates the tail and settles the head, one half of the duration each", () => {
    const half = speedRampHalfFrames({ durationMs: 500 }, FPS);
    for (let k = 1; k < half; k++) expect(out.rate[out.frames - half + k]).toBeGreaterThan(out.rate[out.frames - half + k - 1]);
    for (let j = 1; j < half; j++) expect(into.rate[j]).toBeLessThan(into.rate[j - 1]);
    expect(out.rate[out.frames - half - 1]).toBe(1);
    expect(into.rate[half]).toBe(1);
  });
  it("reads source beyond the out-point (handles) and keeps the body at 1×, with a pre-roll for the incoming head", () => {
    expect(plan.cuts[0].out.mode).toBe("handles");
    expect(plan.cuts[0].in.start).toBe("preroll");
    expect(out.position[out.frames - 1]).toBeGreaterThan(out.frames - 1);
    // The body in between is untouched.
    expect(out.rate.slice(0, out.frames - 8).every((rate) => rate === 1)).toBe(true);
    // The head begins before the in-point, and has caught up with the clip's own timing when it has settled.
    expect(into.position[0]).toBeLessThan(0);
    expect(into.position[8]).toBeCloseTo(8, 6);
  });
  it("leaves the reel's length alone: the plan has one entry per frame and the frame plan is the same as for plain cuts", () => {
    const plain = reel([video("a", 4000, 6000), video("b", 4000, 6000), video("c", 4000, 6000)]);
    expect(timelineDurationMs(timeline)).toBe(timelineDurationMs(plain));
    expect(framePlan(timeline, FPS).clips.map((entry) => [entry.from, entry.durationInFrames])).toEqual(framePlan(plain, FPS).clips.map((entry) => [entry.from, entry.durationInFrames]));
    for (const [id, entry] of plan.clips) expect(entry.position).toHaveLength(framePlan(timeline, FPS).clips.find((candidate) => candidate.clip.id === id)!.durationInFrames);
  });
  it("maps every frame to a source frame the media element lands on exactly", () => {
    for (const [id, entry] of plan.clips) {
      const clip = timeline.clips.find((candidate) => candidate.id === id)!;
      const wanted = sourceFrames(clip, entry);
      for (let f = 0; f < entry.frames; f++) {
        const window = speedRampMediaWindow(clip, entry, f, FPS);
        expect(Number.isInteger(window.trimBefore)).toBe(true);
        // The element reads trimBefore + frame × rate.
        if (f > 0) expect(window.trimBefore + f * window.playbackRate).toBeCloseTo(wanted[f], 6);
        expect(window.sourceFrame).toBeCloseTo(wanted[f], 6);
        // Never past the window, never before the file's first frame: no frame is without a picture.
        expect(window.trimBefore + f * window.playbackRate).toBeLessThanOrEqual(window.trimAfter);
        expect(window.trimBefore).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it("is a plain clip, frame for frame, outside the ramps' frames", () => {
    const clip = timeline.clips[0];
    const window = speedRampMediaWindow(clip, out, 10, FPS);
    const old = mediaWindow(clip, 10, out.frames, FPS);
    expect(window.trimBefore).toBe(old.trimBefore);
    expect(window.playbackRate).toBeCloseTo(old.playbackRate, 9);
    expect(windowShortOfSequence({ ...window, trimAfter: window.trimAfter }, out.frames)).toBe(false);
  });
  it("fades the clip's own sound where the picture is far from its mean speed, and plays it at 1× otherwise", () => {
    const clip = timeline.clips[0];
    expect(speedRampMediaWindow(clip, out, 2, FPS).gain).toBe(1);
    expect(speedRampMediaWindow(clip, out, out.frames - 1, FPS).gain).toBe(0);
    expect(speedRampMediaWindow(timeline.clips[1], into, 0, FPS).gain).toBe(0);
    expect(speedRampMediaWindow(timeline.clips[1], into, into.frames - 1, FPS).gain).toBe(1);
  });
});

describe("blur and push follow the speed", () => {
  const timeline = reel([video("a", 4000, 6000), ramped(video("b", 4000, 6000), { speedRamp: { ...defaultSpeedRamp(), blur: 0.5, push: 0.1 } })]);
  const plan = planSpeedRamps(inputs(timeline, { a: 20000, b: 20000 }), FPS);
  it("is strongest on the frames either side of the cut and gone outside the ramp", () => {
    const out = plan.clips.get("a")!, into = plan.clips.get("b")!;
    expect(out.blurX[out.frames - 1]).toBeCloseTo(0.5 * SPEED_RAMP_BLUR_PX, 6);
    expect(into.blurX[0]).toBeCloseTo(0.5 * SPEED_RAMP_BLUR_PX, 6);
    expect(out.push[out.frames - 1]).toBeCloseTo(0.1, 9);
    expect(into.push[0]).toBeCloseTo(0.1, 9);
    expect(out.blurX[0]).toBe(0);
    expect(into.blurX[into.frames - 1]).toBe(0);
    expect(out.blurY.every((value) => value === 0)).toBe(true);
  });
  it("takes its axis from the direction: auto follows the footage's whip, an angle gives components, none gives no blur", () => {
    expect(blurAxis("auto", "up")).toEqual({ x: 0, y: 1 });
    expect(blurAxis("auto")).toEqual({ x: 1, y: 0 });
    expect(blurAxis("left")).toEqual({ x: 1, y: 0 });
    expect(blurAxis(90)).toEqual({ x: 0, y: 1 });
    expect(blurAxis(45).x).toBeCloseTo(0.707, 3);
    expect(blurAxis("none")).toEqual({ x: 0, y: 0 });
    const vertical = planSpeedRamps(inputs(reel([video("a", 4000, 6000), ramped(video("b", 4000, 6000), { speedRamp: { ...defaultSpeedRamp(), direction: "up" } })]), { a: 20000, b: 20000 }), FPS);
    expect(vertical.clips.get("a")!.blurY.at(-1)).toBeGreaterThan(0);
    expect(vertical.clips.get("a")!.blurX.at(-1)).toBe(0);
    const flat = planSpeedRamps(inputs(reel([video("a", 4000, 6000), ramped(video("b", 4000, 6000), { speedRamp: { ...defaultSpeedRamp(), direction: "none" } })]), { a: 20000, b: 20000 }), FPS);
    expect(Math.max(...flat.clips.get("a")!.blurX, ...flat.clips.get("a")!.blurY)).toBe(0);
    // The push still happens with no blur.
    expect(flat.clips.get("a")!.push.at(-1)).toBeGreaterThan(0);
  });
});

describe("when a clip lacks the source for the ramp", () => {
  it("makes it up by playing the body slightly slower when the end of the source is unknown or too near, ending on the frame it always did", () => {
    const timeline = reel([video("a", 0, 3000), ramped(video("b", 4000, 7000))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 3000, b: 30000 }), FPS);
    const out = plan.clips.get("a")!;
    expect(plan.cuts[0].out.mode).toBe("compensated");
    expect(plan.cuts[0].peak).toBe(4);
    // The last frame shown is the one a plain cut would have shown last.
    expect(clipSourceFrame(timeline.clips[0], out.position[out.frames - 1], out.frames, FPS)).toBeLessThanOrEqual(clipSourceFrame(timeline.clips[0], out.frames - 1, out.frames, FPS) + 1e-6);
    // Slower than 1× before the ramp, never below 1 − the dip limit, and never slower than that.
    const body = out.rate.slice(0, out.frames - 8);
    expect(Math.min(...body)).toBeLessThan(1);
    expect(Math.min(...out.rate)).toBeGreaterThanOrEqual(1 - SPEED_RAMP_MAX_DIP - 1e-9);
    expect(planHasFrozenFrame(timeline.clips[0], out, FPS)).toBe(false);
  });
  it("uses a lower peak, reported as such, when even the deepest slow-down is not enough, and never goes under the floor", () => {
    // A 700 ms clip against the end of its source: no handle, no body to slow.
    const timeline = reel([video("a", 0, 700), ramped(video("b", 4000, 5000))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 700, b: 30000 }), FPS);
    const [cut] = plan.cuts;
    if (cut.skipped) {
      expect(cut.peak).toBe(1);
      expect(cut.note).toMatch(/plain cut/);
    } else {
      expect(cut.out.mode).toBe("reduced");
      expect(cut.peak).toBeLessThan(cut.requestedPeak);
      expect(cut.peak).toBeGreaterThanOrEqual(SPEED_RAMP_MIN_PEAK - 1e-9);
      expect(cut.note).toMatch(/asked for 4×/);
    }
    for (const [id, entry] of plan.clips) expect(planHasFrozenFrame(timeline.clips.find((clip) => clip.id === id)!, entry, FPS)).toBe(false);
  });
  it("keeps a plain cut and says so when a clip is too short to ramp at all", () => {
    const timeline = reel([video("a", 0, 100), ramped(video("b", 4000, 6000))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 100, b: 30000 }), FPS);
    expect(plan.cuts[0]).toMatchObject({ skipped: true, peak: 1 });
    // The long clip is not left blurring and pushing for a cut that does not ramp.
    const b = plan.clips.get("b")!;
    expect(Math.max(...b.blurX)).toBe(0);
    expect(Math.max(...b.push)).toBe(0);
    expect(b.rate.every((rate) => rate === 1)).toBe(true);
  });
  it("never freezes a frame, whatever the length, speed, source or ramp of the clips", () => {
    const lengths = [400, 700, 1200, 2500];
    const speeds = [0.5, 1, 2, 3];
    for (const length of lengths) {
      for (const speed of speeds) {
        for (const sources of [null, 0, 5000]) {
          for (const params of [SPEED_RAMP_PRESETS.soft, SPEED_RAMP_PRESETS.punch, { ...defaultSpeedRamp(), peak: 6, durationMs: 800 }]) {
            const sourceEnd = 1500 + Math.round(length * speed);
            const timeline = reel([video("a", 1500, sourceEnd, { speed }), ramped(video("b", 1500, sourceEnd, { speed }), { speedRamp: { ...params } }), video("c", 1500, sourceEnd, { speed, ramp: null })]);
            const total = sources === null ? null : sourceEnd + sources;
            const plan = planSpeedRamps(inputs(timeline, { a: total, b: total, c: total }), FPS);
            for (const [id, entry] of plan.clips) {
              const clip = timeline.clips.find((candidate) => candidate.id === id)!;
              expect(planHasFrozenFrame(clip, entry, FPS), `${id} ${length}ms ${speed}× ${JSON.stringify(sources)} ${params.peak}×`).toBe(false);
              // Every frame has a picture inside the file.
              for (let f = 0; f < entry.frames; f++) expect(speedRampMediaWindow(clip, entry, f, FPS).sourceFrame).toBeGreaterThanOrEqual(-1e-9);
            }
          }
        }
      }
    }
  });
});

describe("the incoming head", () => {
  it("starts at the in-point at the peak when there is no pre-roll (the clip starts at the file's first frame)", () => {
    const timeline = reel([video("a", 4000, 6000), ramped(video("b", 0, 2000))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 20000, b: 20000 }), FPS);
    const into = plan.clips.get("b")!;
    expect(plan.cuts[0].in.start).toBe("in-point");
    expect(into.position[0]).toBe(0);
    expect(into.rate[0]).toBeCloseTo(4, 9);
    // The clip never needs a frame before the file's first.
    for (let f = 0; f < into.frames; f++) expect(speedRampMediaWindow(timeline.clips[1], into, f, FPS).trimBefore).toBeGreaterThanOrEqual(0);
    expect(speedRampMediaWindow(timeline.clips[1], into, 0, FPS).trimBefore).toBe(0);
  });
  it("reads only as much pre-roll as there is, the rest from the in-point", () => {
    const timeline = reel([video("a", 4000, 6000), ramped(video("b", 100, 2100))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 20000, b: 20000 }), FPS);
    expect(plan.cuts[0].in.start).toBe("partial");
    const window = speedRampMediaWindow(timeline.clips[1], plan.clips.get("b")!, 0, FPS);
    expect(window.trimBefore).toBe(0);
  });
  it("does not read before the in-point under speech, so a trimmed word cannot show", () => {
    const timeline = reel([video("a", 4000, 6000), ramped(video("b", 4000, 6000))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 20000, b: 20000 }, ["b"]), FPS);
    expect(plan.cuts[0].in.start).toBe("in-point");
    expect(plan.clips.get("b")!.position[0]).toBe(0);
  });
  it("shares one peak across the cut when the two clips can play different ones", () => {
    // The outgoing clip ends its source; the incoming has all the source it needs.
    const timeline = reel([video("a", 0, 900), ramped(video("b", 4000, 6000))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 900, b: 20000 }), FPS);
    if (plan.cuts[0].skipped) return;
    const out = plan.clips.get("a")!, into = plan.clips.get("b")!;
    expect(out.rate[out.frames - 1]).toBeCloseTo(plan.cuts[0].peak, 9);
    expect(into.rate[0]).toBeCloseTo(plan.cuts[0].peak, 9);
  });
});

describe("a clip between two speed-ramp cuts, and photos", () => {
  it("has a head and a tail in one plan and keeps the earlier cut's peak when the later one gives way", () => {
    const timeline = reel([video("a", 4000, 6000), ramped(video("b", 3000, 3700)), ramped(video("c", 4000, 6000))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 20000, b: 3700, c: 20000 }), FPS);
    const middle = plan.clips.get("b")!;
    const [first, second] = plan.cuts;
    // The head of the middle clip runs the first cut's peak whatever happened at the second.
    expect(middle.rate[0]).toBeCloseTo(first.peak, 9);
    if (!second.skipped) expect(middle.rate[middle.frames - 1]).toBeCloseTo(second.peak, 9);
    expect(planHasFrozenFrame(timeline.clips[1], middle, FPS)).toBe(false);
  });
  it("blurs and pushes a photo without touching any source", () => {
    const photo: Clip = { ...video("p", 0, 2000), kind: "IMAGE" } as Clip;
    const timeline = reel([photo, ramped(video("b", 4000, 6000))]);
    const plan = planSpeedRamps(inputs(timeline, { b: 20000 }), FPS);
    const entry = plan.clips.get("p")!;
    expect(entry.blurX.at(-1)).toBeGreaterThan(0);
    expect(planHasFrozenFrame(photo, entry, FPS)).toBe(false);
    expect(plan.cuts[0].out.mode).toBe("exact");
  });
  it("ignores a speed ramp on the first clip, which has no cut before it", () => {
    const plan = planSpeedRamps(inputs(reel([ramped(video("a", 0, 2000)), video("b", 0, 2000)]), { a: 9000, b: 9000 }), FPS);
    expect(plan.cuts).toEqual([]);
    expect(plan.clips.size).toBe(0);
  });
  it("composes with the clip's own ramp: the extra source continues the curve", () => {
    const own = { preset: "custom", keys: [{ p: 0, v: 0.8 }, { p: 1, v: 1.2 }] } as Clip["ramp"];
    const timeline = reel([video("a", 4000, 6000, { ramp: own }), ramped(video("b", 4000, 6000))]);
    const plan = planSpeedRamps(inputs(timeline, { a: 20000, b: 20000 }), FPS);
    const out = plan.clips.get("a")!;
    expect(out.position[out.frames - 1]).toBeGreaterThan(out.frames - 1);
    expect(planHasFrozenFrame(timeline.clips[0], out, FPS)).toBe(false);
  });
});

describe("planClipSpeed on its own", () => {
  it("is the identity without a head or a tail", () => {
    const result = planClipSpeed({ clip: video("a", 1000, 3000), frames: 60, head: null, tail: null, sourceFrames: null });
    expect(result.plan.position).toEqual(Array.from({ length: 60 }, (_, f) => f));
    expect(result.tail.mode).toBe("none");
  });
});

describe("the commands", () => {
  const timeline = reel([video("a", 4000, 6000), video("b", 4000, 6000), video("c", 4000, 6000)]);
  const apply = (command: Parameters<typeof applyCommand>[1], base: Timeline = timeline) => applyCommand(base, command, { generation: 0 });

  it("sets a speed ramp with its parameters, filling in the defaults, as one change", () => {
    const result = apply({ type: "setTransition", clipId: "b", transition: "speedRamp", speedRamp: { peak: 5, blur: 0.8 } });
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.clips[1]).toMatchObject({ transitionIn: "speedRamp", speedRamp: { durationMs: 500, peak: 5, blur: 0.8, push: 0.08, direction: "auto" } });
    expect(result.changes).toEqual([{ kind: "clip", id: "b" }]);
    // The reel is no longer or shorter.
    expect(timelineDurationMs(result.timeline)).toBe(timelineDurationMs(timeline));
  });
  it("takes the { kind } form agents write, and a preset", () => {
    const inline = apply({ type: "setTransition", clipId: "c", transition: { kind: "speedRamp", peak: 3, direction: "up" } });
    expect(inline.timeline.clips[2]).toMatchObject({ transitionIn: "speedRamp", speedRamp: { peak: 3, direction: "up" } });
    const preset = apply({ type: "setTransition", clipId: "c", transition: { kind: "speedRamp", preset: "punch" } });
    expect(preset.timeline.clips[2].speedRamp).toMatchObject({ peak: 5, durationMs: 300 });
    // Changing one parameter later keeps the rest.
    const later = apply({ type: "setTransition", clipId: "c", transition: "speedRamp", speedRamp: { peak: 2.5 } }, preset.timeline);
    expect(later.timeline.clips[2].speedRamp).toMatchObject({ peak: 2.5, durationMs: 300, blur: 0.75 });
  });
  it("refuses a parameter out of range, an unknown preset and the first shot, naming the problem, so a batch holding it lands nowhere", () => {
    expect(apply({ type: "setTransition", clipId: "b", transition: "speedRamp", speedRamp: { peak: 12 } }).rejected).toMatch(/peak/);
    expect(apply({ type: "setTransition", clipId: "b", transition: { kind: "speedRamp", durationMs: 50 } }).rejected).toMatch(/durationMs/);
    expect(apply({ type: "setTransition", clipId: "b", transition: { kind: "speedRamp", preset: "wild" as never } }).rejected).toMatch(/no speed ramp called wild/);
    expect(apply({ type: "setTransition", clipId: "a", transition: "speedRamp" }).rejected).toMatch(/first shot/);
    expect(apply({ type: "setTransition", clipId: "nope", transition: "speedRamp" }).rejected).toBeTruthy();
    const batch = apply({ type: "batch", commands: [{ type: "setTransition", clipId: "b", transition: "speedRamp" }, { type: "setTransition", clipId: "c", transition: "speedRamp", speedRamp: { peak: 99 } }] });
    expect(batch.rejected).toBeTruthy();
    expect(batch.timeline).toBe(timeline);
  });
  it("still sets the other transitions as before", () => {
    expect(apply({ type: "setTransition", clipId: "b", transition: "whip", whipDirection: "up" }).timeline.clips[1]).toMatchObject({ transitionIn: "whip", whipDirection: "up" });
    expect(apply({ type: "setTransition", clipId: "b", transition: "fade" }).timeline.clips[1].transitionIn).toBe("fade");
  });
  it("turns a speed ramp's blur to follow the footage with matchCuts, like a whip", () => {
    const withRamp = apply({ type: "setTransition", clipId: "b", transition: "speedRamp", whipDirection: "up" }).timeline;
    expect(withRamp.clips[1].whipDirection).toBe("up");
    // Content leaves a to the left, so the camera pans right and the streak follows.
    const motion = { a: { start: { dx: -30, dy: 0 }, end: { dx: -30, dy: 0 }, subject: null, energy: 0.6 }, b: { start: { dx: 0, dy: 0 }, end: { dx: 0, dy: 0 }, subject: null, energy: 0.1 } };
    const result = apply({ type: "matchCuts", motion, reorder: false }, withRamp);
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.clips[1].whipDirection).toBe("right");
  });
});

describe("pace: speed-ramp the strong cuts", () => {
  const clips = Array.from({ length: 8 }, (_, i) => video(`c${i}`, 0, 8000, { volume: 0 }));
  const music = { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 120, beatOffsetMs: 0, downbeats: [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000],
    sections: [{ kind: "intro", startMs: 0, endMs: 4000 }, { kind: "build", startMs: 4000, endMs: 8000 }, { kind: "drop", startMs: 8000, endMs: 24000 }] };
  const timeline = parseTimeline({ version: 1, clips, texts: [], music });
  const context = { generation: 0, sourceDurationsMs: Object.fromEntries(clips.map((c) => [c.assetId, 8000])) };

  it("is off by default and leaves every cut as it was", () => {
    const result = applyCommand(timeline, { type: "pace", energy: 0.75 }, context);
    expect(result.timeline.clips.every((clip) => clip.transitionIn === "cut")).toBe(true);
    expect(result.timeline.music?.speedRamps).toBeUndefined();
  });
  it("puts speed ramps on strong cuts in the build and the drop only, on the downbeat, never two in a row, remembered on the music", () => {
    const on = applyCommand(timeline, { type: "pace", energy: 0.75, speedRamps: true, ramps: true }, context);
    expect(on.rejected).toBeUndefined();
    const placed = on.timeline.clips.map((clip, index) => ({ clip, index })).filter(({ clip }) => clip.transitionIn === "speedRamp");
    expect(placed.length).toBeGreaterThan(0);
    expect(on.timeline.music?.speedRamps).toBe(true);
    const plan = framePlan(on.timeline, FPS);
    const starts = plan.clips.map((entry) => (entry.from * 1000) / FPS);
    for (const { clip, index } of placed) {
      expect(clip.speedRamp?.auto).toBe(true);
      expect(index).toBeGreaterThan(0);
      expect(starts[index]).toBeGreaterThanOrEqual(4000 - 40);
      // On a bar line (a downbeat of the 2 s bars).
      expect(Math.abs(starts[index] / 2000 - Math.round(starts[index] / 2000))).toBeLessThan(0.02);
      // The shot before it does not also ramp on its own into the same cut.
      expect(on.timeline.clips[index - 1].ramp?.preset).not.toBe("into-cut");
      expect(on.timeline.clips[index - 1].transitionIn).not.toBe("speedRamp");
    }
    // Later Energy changes keep them; switching it off takes back only what Pace placed.
    const again = applyCommand(on.timeline, { type: "pace", energy: 0.5 }, context);
    expect(again.timeline.clips.some((clip) => clip.transitionIn === "speedRamp")).toBe(true);
    const off = applyCommand(again.timeline, { type: "pace", energy: 0.5, speedRamps: false }, context);
    expect(off.timeline.music?.speedRamps).toBe(false);
    expect(off.timeline.clips.every((clip) => clip.transitionIn === "cut" && !clip.speedRamp)).toBe(true);
  });
  it("leaves a speed ramp the studio set themselves when it is switched off, and does not replace their own transitions", () => {
    const own = { ...timeline, clips: timeline.clips.map((clip, i) => (i === 3 ? { ...clip, transitionIn: "speedRamp" as const, speedRamp: { ...defaultSpeedRamp(), peak: 2 } } : i === 2 ? { ...clip, transitionIn: "whip" as const } : clip)) };
    const off = paceTimeline(own, { energy: 0.75, sourceDurationsMs: context.sourceDurationsMs, speedRamps: false });
    expect(off.clips.filter((clip) => clip.transitionIn === "speedRamp")).toHaveLength(1);
    expect(off.clips.filter((clip) => clip.transitionIn === "whip")).toHaveLength(1);
  });
});

describe("the retention critic and the export checks on a ramped render", () => {
  // Frames the way a render of two speed-ramp cuts would show them: lit throughout, softer (lower contrast) in the
  // blurred frames either side of each cut, always moving.
  const W = 18, H = 32;
  const picture = (luma: number, amplitude: number, seed: number): CriticFrame => {
    const frame = { width: W, height: H, luma: new Float32Array(W * H) };
    frame.luma.forEach((_, i) => { frame.luma[i] = Math.min(1, Math.max(0, luma + amplitude * Math.sin(i * 0.9 + seed))); });
    return frame;
  };
  const clipsOf = (transition: Clip["transitionIn"]) => [video("a", 0, 4000, { volume: 0 }), { ...video("b", 0, 4000, { volume: 0 }), transitionIn: transition }, { ...video("c", 0, 4000, { volume: 0 }), transitionIn: transition }];
  const timelineOf = (transition: Clip["transitionIn"]) => reel(clipsOf(transition));
  const cuts = [4000, 8000];
  const near = (ms: number) => cuts.some((cut) => Math.abs(ms - cut) < 280);
  const series: FrameSeries = Array.from({ length: 360 }, (_, k) => {
    const ms = Math.round((k * 1000) / 30);
    return { ms, frame: picture(0.5, near(ms) ? 0.02 : 0.1, ms / 40) };
  });

  it("finds no black frame, flash, frozen picture or empty opening, and sees the motion", () => {
    const facts = analyseSeries(series, timelineOf("speedRamp"));
    expect(facts.black).toEqual([]);
    expect(facts.flashFrames).toEqual([]);
    expect(facts.frozen).toEqual([]);
    expect(facts.openingBlack).toBe(false);
    expect(Math.max(...facts.motionPerSecond)).toBeGreaterThan(0);
  });
  it("raises no dead air or off-beat finding that the same reel with plain cuts does not, and counts the transition as a transform", () => {
    const song = { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 120, beatOffsetMs: 0 };
    const plain = parseTimeline({ version: 1, clips: clipsOf("cut"), texts: [], music: song });
    const ramps = parseTimeline({ version: 1, clips: clipsOf("speedRamp"), texts: [], music: song });
    const ids = (timeline: Timeline) => retentionFindings({ timeline, series }).map((finding) => finding.id).sort();
    expect(ids(ramps).filter((id) => id.startsWith("dead-air") || id.startsWith("beat"))).toEqual(ids(plain).filter((id) => id.startsWith("dead-air") || id.startsWith("beat")));
    expect(transformScoreOf(ramps.clips[1], ramps, 4000)).toBeGreaterThan(transformScoreOf(plain.clips[1], plain, 4000));
  });
});
