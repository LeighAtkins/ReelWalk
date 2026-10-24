import { describe, expect, it } from "vitest";
import {
  applyCommand, classify, defaultSpeedRamp, framePlan, mergeRampFootage, parseTimeline, planSpeedRamps, sharedFocus, resolveStreak,
  type Clip, type ClipMotion, type MotionRead, type ReelClipInput, type SpeedRampParams, type Timeline,
} from "../src";

// "Match the footage" on one cut must change that cut and nothing else (the v1b ramp reel: each run clobbered its neighbours).

const FPS = 30;
const video = (id: string, extra: Partial<Clip> = {}): Clip =>
  ({ id, assetId: `asset-${id}`, kind: "VIDEO", sourceStartMs: 4000, sourceEndMs: 7000, speed: 1, volume: 1, fit: "cover", filter: "none", motion: "none", pano: null, spot: null, room: null, transitionIn: "cut", zoom: 1, ...extra }) as Clip;
const reel = (clips: Clip[]): Timeline => parseTimeline({ version: 1, clips, texts: [], music: null });
const inputs = (timeline: Timeline): ReelClipInput[] => framePlan(timeline, FPS).clips.map(({ clip, durationInFrames }) => ({ clip, durationInFrames, sourceDurationMs: 30000 }));
const read = (rates: Partial<Parameters<typeof classify>[0]>): MotionRead => classify({ tx: 0, ty: 0, zoom: 0, rotate: 0, ...rates });
const motion = (start: MotionRead, end: MotionRead): ClipMotion => ({ start: { dx: start.tx * 48, dy: start.ty * 48 }, end: { dx: end.tx * 48, dy: end.ty * 48 }, subject: null, energy: 0.4, startRead: start, endRead: end });
const apply = (timeline: Timeline, command: Parameters<typeof applyCommand>[1]) => {
  const result = applyCommand(timeline, command, { generation: 0 });
  expect(result.rejected).toBeUndefined();
  return result.timeline;
};

// Eight shots, seven speed-ramp cuts. The readings differ shot to shot so every side resolves to something recognisable.
const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
const KINDS = [read({ zoom: 0.3 }), read({ tx: 0.08 }), read({ ty: -0.1 }), read({ zoom: -0.3 }), read({ tx: -0.08 }), read({ ty: 0.1 })];
const measured: Record<string, ClipMotion> = Object.fromEntries(ids.map((id, i) => [id, motion(KINDS[(i + 2) % KINDS.length], KINDS[i % KINDS.length])]));
const fresh = () => reel(ids.map((id, i) => video(id, i === 0 ? {} : { transitionIn: "speedRamp", speedRamp: defaultSpeedRamp() })));

/** Match the footage on the cut into clip `index`, the way the Transition sheet does: only the two shots around it measured. */
function matchCut(timeline: Timeline, index: number, readings: Record<string, ClipMotion> = measured): Timeline {
  const picked = Object.fromEntries([ids[index - 1], ids[index]].map((id) => [id, readings[id]]));
  return apply(timeline, { type: "matchCuts", motion: picked, reorder: false, cuts: [ids[index]] });
}
const footageOf = (timeline: Timeline) => timeline.clips.map((clip) => clip.rampFootage);
const blurOf = (timeline: Timeline) => planSpeedRamps(inputs(timeline), FPS).cuts.map((cut) => [cut.blur.out.kind, cut.blur.in.kind]);

describe("Match the footage on one cut", () => {
  it("changes only that cut: cut 2, then 4, then 6 leave the earlier cuts' readings and blur kinds as they were", () => {
    let timeline = fresh();
    const done: { cut: number; footage: Clip["rampFootage"]; blur: string[] }[] = [];
    for (const cut of [2, 4, 6]) {
      const before = timeline;
      timeline = matchCut(timeline, cut);
      // The cut that was run has both sides, and the clip it was read from.
      expect(timeline.clips[cut].rampFootage).toMatchObject({ after: ids[cut - 1] });
      expect(timeline.clips[cut].rampFootage?.out).toBeDefined();
      expect(timeline.clips[cut].rampFootage?.in).toBeDefined();
      // Everything else is exactly as it was: the footage, and the whip directions the same command may set.
      timeline.clips.forEach((clip, i) => {
        if (i === cut) return;
        expect(clip.rampFootage).toEqual(before.clips[i].rampFootage);
        expect(clip.whipDirection).toEqual(before.clips[i].whipDirection);
      });
      // Each earlier cut still holds, and resolves to, what it did when it was run.
      for (const earlier of done) {
        expect(timeline.clips[earlier.cut].rampFootage).toEqual(earlier.footage);
        expect(blurOf(timeline)[earlier.cut - 1]).toEqual(earlier.blur);
      }
      done.push({ cut, footage: timeline.clips[cut].rampFootage, blur: blurOf(timeline)[cut - 1] });
    }
    // Cuts 1, 3, 5, 7 were never run, so they hold nothing.
    expect([1, 3, 5, 7].map((i) => timeline.clips[i].rampFootage)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("does not touch readings stored for the neighbouring cuts, even when it is re-run with a different answer", () => {
    const seeded = apply(fresh(), { type: "matchCuts", motion: measured, reorder: false });
    // Cut 4 is read again, and this time both shots hold still.
    const still = { ...measured, [ids[3]]: motion(read({}), read({})), [ids[4]]: motion(read({}), read({})) };
    const again = matchCut(seeded, 4, still);
    again.clips.forEach((clip, i) => {
      if (i === 4) return;
      expect(clip.rampFootage).toEqual(seeded.clips[i].rampFootage);
      expect(clip.whipDirection).toEqual(seeded.clips[i].whipDirection);
    });
    expect(again.clips[4].rampFootage?.out?.kind).toBe("still");
    expect(again.clips[4].rampFootage?.in?.kind).toBe("still");
    const kinds = blurOf(again), before = blurOf(seeded);
    kinds.forEach((pair, i) => { if (i !== 3) expect(pair).toEqual(before[i]); });
  });

  it("is the same result as one batch with every shot's readings, cut by cut in either order", () => {
    const batch = apply(fresh(), { type: "matchCuts", motion: measured, reorder: false });
    let byCut = fresh();
    for (let cut = 1; cut < ids.length; cut++) byCut = matchCut(byCut, cut);
    expect(footageOf(byCut)).toEqual(footageOf(batch));
    expect(blurOf(byCut)).toEqual(blurOf(batch));
    let backwards = fresh();
    for (let cut = ids.length - 1; cut >= 1; cut--) backwards = matchCut(backwards, cut);
    expect(footageOf(backwards)).toEqual(footageOf(batch));
    expect(backwards.clips.map((clip) => clip.whipDirection)).toEqual(batch.clips.map((clip) => clip.whipDirection));
  });

  it("still ignores a reading whose outgoing shot is no longer the one before, and keeps the valid ones after a cut-local update", () => {
    const seeded = apply(fresh(), { type: "matchCuts", motion: measured, reorder: false });
    const original = planSpeedRamps(inputs(seeded), FPS).cuts;
    // Swap shots c and d: the cuts into d, c and e now follow different shots.
    const order = ["a", "b", "d", "c", "e", "f", "g", "h"];
    const swapped = reel(order.map((id) => seeded.clips.find((clip) => clip.id === id)!));
    const stale = planSpeedRamps(inputs(swapped), FPS).cuts;
    for (const i of [1, 2, 3]) expect(stale[i].blur.out.why).toMatch(/not read/);
    // The cuts nothing moved around keep their outgoing readings.
    for (const i of [0, 4, 5, 6]) expect(stale[i].blur.out).toEqual(original[i].blur.out);
    // Running the cut into d on the new order re-reads its outgoing side and changes no other cut.
    const fixed = apply(swapped, { type: "matchCuts", motion: { b: measured.b, d: measured.d }, reorder: false, cuts: ["d"] });
    expect(fixed.clips[2].rampFootage).toMatchObject({ after: "b" });
    expect(planSpeedRamps(inputs(fixed), FPS).cuts[1].blur.out.why).not.toMatch(/not read/);
    fixed.clips.forEach((clip, i) => { if (i !== 2) expect(clip.rampFootage).toEqual(swapped.clips[i].rampFootage); });
    // The cuts beside it that went stale are still ignored, not revived by the update.
    expect(planSpeedRamps(inputs(fixed), FPS).cuts[2].blur.out.why).toMatch(/not read/);
  });

  it("reordering through matchCuts re-reads against the new order, so no reading is left pointing at the wrong shot", () => {
    const seeded = apply(fresh(), { type: "matchCuts", motion: measured, reorder: false });
    const reordered = apply(seeded, { type: "matchCuts", motion: measured });
    reordered.clips.forEach((clip, i) => {
      if (i === 0 || clip.transitionIn !== "speedRamp") return;
      expect(clip.rampFootage?.after).toBe(reordered.clips[i - 1].id);
    });
  });

  it("refuses a cut that is not in the reel, so a batch holding it lands nowhere", () => {
    const result = applyCommand(fresh(), { type: "matchCuts", motion: measured, cuts: ["zzz"] }, { generation: 0 });
    expect(result.rejected).toMatch(/zzz/);
  });

  it("keeps the other side when a reading has only one", () => {
    const stored = { after: "a", out: { kind: "zoom-in" as const }, in: { kind: "pan-x" as const } };
    expect(mergeRampFootage(stored, { after: "a", in: { kind: "still" } })).toEqual({ after: "a", out: { kind: "zoom-in" }, in: { kind: "still" } });
    expect(mergeRampFootage(stored, { after: "z", out: { kind: "pan-y" } })).toEqual({ after: "z", out: { kind: "pan-y" }, in: { kind: "pan-x" } });
    expect(mergeRampFootage(undefined, { after: "a", out: { kind: "pan-y" } })).toEqual({ after: "a", out: { kind: "pan-y" } });
  });
});

describe("the zoom blur's focus across a cut", () => {
  const push = { kind: "zoom-in" as const, focus: { x: 0.3, y: 0.4 } };
  const pull = { kind: "zoom-out" as const, focus: { x: 0.7, y: 0.6 } };
  const cut = (footage: Clip["rampFootage"], extra: Partial<SpeedRampParams> = {}) =>
    reel([video("a"), video("b", { transitionIn: "speedRamp", speedRamp: { ...defaultSpeedRamp(), ...extra }, rampFootage: footage })]);
  /** The focus the strongest frame of each side is drawn with. */
  function focusAtCut(timeline: Timeline) {
    const plan = planSpeedRamps(inputs(timeline), FPS);
    const tail = plan.clips.get("a")!, head = plan.clips.get("b")!;
    const last = tail.frames - 1;
    const first = head.zoom.indexOf(Math.max(...head.zoom));
    return { out: [tail.focusX[last], tail.focusY[last]], into: [head.focusX[first], head.focusY[first]], outZoom: tail.zoom[last], inZoom: head.zoom[first] };
  }

  it("is shared by default when both sides are zoom blurs: the burst is centred on the middle of the two vanishing points", () => {
    const at = focusAtCut(cut({ after: "a", out: push, in: pull }));
    expect(at.outZoom).toBeGreaterThan(0);
    expect(at.inZoom).toBeGreaterThan(0);
    expect(at.out).toEqual([0.5, 0.5]);
    expect(at.into).toEqual([0.5, 0.5]);
    const near = focusAtCut(cut({ after: "a", out: push, in: { kind: "zoom-in", focus: { x: 0.34, y: 0.42 } } }));
    expect(near.out).toEqual(near.into);
    expect(near.out).toEqual([0.32, 0.41]);
  });

  it("can be turned off: each side keeps its own focus", () => {
    const at = focusAtCut(cut({ after: "a", out: push, in: pull }, { shareFocus: false }));
    expect(at.out).toEqual([0.3, 0.4]);
    expect(at.into).toEqual([0.7, 0.6]);
  });

  it("takes the one focus that was read when the other side has none (a zoom as asked on footage that was not read)", () => {
    const at = focusAtCut(cut({ after: "a", out: push }, { direction: "zoom" }));
    expect(at.out).toEqual([0.3, 0.4]);
    expect(at.into).toEqual([0.3, 0.4]);
    const unread = focusAtCut(cut(undefined, { direction: "zoom" }));
    expect(unread.out).toEqual([0.5, 0.5]);
    expect(unread.into).toEqual([0.5, 0.5]);
  });

  it("leaves a cut alone when a side is not a zoom blur", () => {
    const at = focusAtCut(cut({ after: "a", out: push, in: { kind: "pan-x" } }));
    expect(at.out).toEqual([0.3, 0.4]);
    expect(sharedFocus(resolveStreak("auto", undefined, push), push, resolveStreak("auto", undefined, { kind: "pan-x" }), { kind: "pan-x" })).toBeNull();
  });

  it("is an option the command and the schema accept; absent means shared", () => {
    const base = reel([video("a"), video("b")]);
    const set = apply(base, { type: "setTransition", clipId: "b", transition: { kind: "speedRamp", shareFocus: false } });
    expect(set.clips[1].speedRamp?.shareFocus).toBe(false);
    const plain = apply(base, { type: "setTransition", clipId: "b", transition: { kind: "speedRamp" } });
    expect(plain.clips[1].speedRamp?.shareFocus).toBeUndefined();
    expect(defaultSpeedRamp().shareFocus).toBeUndefined();
  });
});
