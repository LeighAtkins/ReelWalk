import { describe, expect, it } from "vitest";
import {
  applyCommand, cameraKeysAt, cameraPreset, cameraStillAtStart, clipCameraAt, clipOffsetMsAtSource, clipPicture, clipSourceFrame, clipSourceMsAt, clipSourceSeconds, compositionToSource, customRamp,
  cutsWellAfter, easeValue, framePlan, matchCutScore, mediaWindow, motionDirection, msToFrame, onScreenAt, openingProgress, parseTimeline, planPace, rampGain, rampPeak, rampPreset, rampSpeedAt, rampUnwarp, rampWarp,
  sliceRamp, sourceToComposition, splitAt, suggestMatchCuts, summariseMotion, whipDirectionFor, windowShortOfSequence, type Clip, type ClipMotion, type Gray, type Timeline,
} from "../src";

const video = (id: string, sourceStartMs: number, sourceEndMs: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, assetId: `asset-${id}`, kind: "VIDEO", sourceStartMs, sourceEndMs, speed: 1, volume: 1, fit: "cover", filter: "none", motion: "none", pano: null, spot: null, room: null, transitionIn: "cut", zoom: 1, ...extra }) as Clip;
const reel = (clips: Clip[], texts: Timeline["texts"] = []): Timeline => parseTimeline({ version: 1, clips, texts, music: null });

describe("frame-exact cuts (the black frame)", () => {
  // The owner's cuts: 3025, 11333 and 22167 ms are 20–30 ms off a frame boundary at 30 fps.
  const cuts = [3025, 11333, 22167, 30000];
  const clips = cuts.map((end, i) => video(`c${i}`, 1020 + i * 7, 1020 + i * 7 + end - (cuts[i - 1] ?? 0), { speed: [1, 2, 0.5, 1.5][i] as number }));
  const timeline = reel(clips.map((clip, i) => ({ ...clip, sourceEndMs: clip.sourceStartMs + Math.round((cuts[i] - (cuts[i - 1] ?? 0)) * clip.speed) })));

  it("gives every clip a media window at least as long as its sequence, at every speed", () => {
    const plan = framePlan(timeline, 30);
    for (const entry of plan.clips) {
      for (let frame = 0; frame < entry.durationInFrames; frame++) {
        const window = mediaWindow(entry.clip, frame, entry.durationInFrames, 30);
        expect(windowShortOfSequence(window, entry.durationInFrames)).toBe(false);
        expect(window.trimBefore).toBe(msToFrame(entry.clip.sourceStartMs, 30));
      }
    }
    // The sequences tile the reel with no gap and no overlap.
    plan.clips.forEach((entry, i) => { if (i > 0) expect(entry.from).toBe(plan.clips[i - 1].from + plan.clips[i - 1].durationInFrames); });
  });

  it("shows the old rounding was one frame short on such a cut", () => {
    // The composition used to trim on its own rounding of the end time: a clip 1020–4045 ms at 1× (3025 ms, 91 frames)
    // trimmed to frames 31–121 (90 frames) and had nothing for frame 90.
    const clip = video("x", 1020, 4045);
    const frames = framePlan(reel([clip]), 30).clips[0].durationInFrames;
    expect(frames).toBe(91);
    const old = { trimBefore: Math.round((1020 * 30) / 1000), trimAfter: Math.round((4045 * 30) / 1000), playbackRate: 1, gain: 1 };
    expect(windowShortOfSequence(old, frames)).toBe(true);
    expect(windowShortOfSequence(mediaWindow(clip, 90, frames, 30), frames)).toBe(false);
  });

  it("keeps the media's start frame and rate exactly as before for a plain clip", () => {
    const clip = video("x", 1020, 4045, { speed: 2 });
    const window = mediaWindow(clip, 10, 45, 30);
    expect(window).toMatchObject({ trimBefore: 31, playbackRate: 2, gain: 1 });
    expect(clipSourceFrame(clip, 10, 45, 30)).toBe(31 + 20);
    expect(clipSourceSeconds(clip, 10, 30)).toBeCloseTo(1.02 + (10 / 30) * 2, 9);
  });
});

describe("speed ramps", () => {
  it("every preset warps 0 to 0 and 1 to 1, rises monotonically and has a mean speed of 1", () => {
    for (const preset of ["slow-in", "slow-out", "into-cut", "hold-snap", "hit"] as const) {
      const ramp = rampPreset(preset);
      expect(rampWarp(ramp, 0)).toBe(0);
      expect(rampWarp(ramp, 1)).toBeCloseTo(1, 9);
      let last = 0, mean = 0;
      const n = 200;
      for (let i = 1; i <= n; i++) {
        const w = rampWarp(ramp, i / n);
        expect(w).toBeGreaterThanOrEqual(last);
        last = w;
        mean += rampSpeedAt(ramp, (i - 0.5) / n) / n;
      }
      expect(mean).toBeCloseTo(1, 2);
      // The inverse gives back the fraction.
      for (const p of [0.1, 0.33, 0.5, 0.8, 0.97]) expect(rampUnwarp(ramp, rampWarp(ramp, p))).toBeCloseTo(p, 6);
    }
  });

  it("ramps into the cut: slow first, fastest on the last frames", () => {
    const ramp = rampPreset("into-cut");
    expect(rampSpeedAt(ramp, 0.2)).toBeLessThan(1);
    expect(rampSpeedAt(ramp, 0.99)).toBeGreaterThan(2);
    expect(rampPeak(ramp)).toBeGreaterThan(2);
    // A hit starts fast: motion on frame 0.
    expect(rampSpeedAt(rampPreset("hit"), 0)).toBeGreaterThan(2);
  });

  it("keeps the clip's length and starts but moves where it is inside", () => {
    const plain = video("a", 1000, 4000);
    const ramped = { ...plain, ramp: rampPreset("into-cut") };
    const timeline = reel([ramped, video("b", 0, 2000)]);
    expect(framePlan(timeline, 30).clips.map((c) => [c.from, c.durationInFrames])).toEqual(framePlan(reel([plain, video("b", 0, 2000)]), 30).clips.map((c) => [c.from, c.durationInFrames]));
    // Half way through the clip's time it is well short of half way through its source.
    expect(clipSourceMsAt(ramped, 1500)).toBeLessThan(2200);
    expect(clipSourceMsAt(plain, 1500)).toBe(2500);
    expect(clipOffsetMsAtSource(ramped, clipSourceMsAt(ramped, 1500))).toBeCloseTo(1500, 6);
    expect(onScreenAt(timeline, 1500)!.sourceMs).toBeCloseTo(clipSourceMsAt(ramped, 1500), 6);
  });

  it("asks the media for the exact source frame at every frame, with a rate that lands there", () => {
    const clip = video("a", 1000, 4000, { ramp: rampPreset("hold-snap") });
    const frames = 90;
    for (let f = 0; f < frames; f++) {
      const window = mediaWindow(clip, f, frames, 30);
      const where = window.trimBefore + f * window.playbackRate;
      expect(where).toBeCloseTo(clipSourceFrame(clip, f, frames, 30), 6);
      expect(windowShortOfSequence(window, frames)).toBe(false);
    }
    // The mattes' clock agrees with the footage.
    expect(clipSourceSeconds(clip, 80, 30, frames) * 30).toBeCloseTo(1 * 30 + (clipSourceFrame(clip, 80, frames, 30) - 30), 6);
  });

  it("fades the clip's own sound where the ramp is far from its mean", () => {
    expect(rampGain(1)).toBe(1);
    expect(rampGain(1.2)).toBe(1);
    expect(rampGain(3)).toBe(0);
    expect(rampGain(1.5)).toBeGreaterThan(0);
    expect(rampGain(1.5)).toBeLessThan(1);
    const clip = video("a", 0, 3000, { ramp: rampPreset("into-cut") });
    // The hold plays at about two thirds of the mean: a little quieter; the snap into the cut is silent.
    expect(mediaWindow(clip, 5, 90, 30).gain).toBeGreaterThan(0.5);
    expect(mediaWindow(clip, 5, 90, 30).gain).toBeLessThan(1);
    expect(mediaWindow(clip, 88, 90, 30).gain).toBe(0);
    expect(mediaWindow(video("b", 0, 3000, { ramp: rampPreset("slow-out") }), 10, 90, 30).gain).toBe(1);
  });

  it("splits a ramped clip into pieces that each keep their part of the curve", () => {
    const clip = video("a", 0, 4000, { ramp: rampPreset("into-cut") });
    const after = splitAt(reel([clip]), 1800, "a2");
    expect(after.clips).toHaveLength(2);
    expect(after.clips[0].sourceEndMs).toBe(Math.round(clipSourceMsAt(clip, 1800)));
    expect(after.clips[0].ramp).toBeNull(); // the first 45% is the flat hold: no ramp
    expect(after.clips[1].ramp?.preset).toBe("custom");
    expect(rampSpeedAt(after.clips[1].ramp, 1)).toBeGreaterThan(rampSpeedAt(after.clips[1].ramp, 0));
    expect(sliceRamp(null, 0, 0.5)).toBeNull();
  });

  it("validates custom keys", () => {
    expect(() => customRamp([{ p: 0.2, v: 1 }, { p: 1, v: 2 }])).toThrow();
    expect(customRamp([{ p: 0, v: 1 }, { p: 1, v: 2 }]).preset).toBe("custom");
  });

  it("is set, cleared and refused through the commands, without retiming anything", () => {
    const timeline = reel([video("a", 0, 3000), video("b", 0, 3000)], [{ id: "t", text: "hi", x: 0.5, y: 0.5, size: 1, style: "plain", color: "#ffffff", animation: "auto", startMs: 500, endMs: 2500 } as Timeline["texts"][number]]);
    const set = applyCommand(timeline, { type: "setRamp", clipId: "a", ramp: "into-cut" }, { generation: 0 });
    expect(set.timeline.clips[0].ramp?.preset).toBe("into-cut");
    expect(set.timeline.texts).toEqual(timeline.texts);
    expect(set.changes).toEqual([{ kind: "clip", id: "a" }]);
    const cleared = applyCommand(set.timeline, { type: "setRamp", clipId: "a", ramp: null }, { generation: 0 });
    expect(cleared.timeline.clips[0].ramp).toBeNull();
    expect(applyCommand(timeline, { type: "setRamp", clipId: "a", ramp: "warp" as never }, { generation: 0 }).rejected).toMatch(/no ramp/);
    // A saved reel without the field parses as before.
    expect(parseTimeline(JSON.parse(JSON.stringify(timeline))).clips[0].ramp).toBeUndefined();
  });

  it("lets the pacing engine ramp the shots in the build and the drop into their cuts", () => {
    const clips = Array.from({ length: 6 }, (_, i) => video(`c${i}`, 0, 8000, { volume: 0 }));
    const period = 500;
    const music = { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 120, beatOffsetMs: 0, downbeats: [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000],
      sections: [{ kind: "intro", startMs: 0, endMs: 4000 }, { kind: "build", startMs: 4000, endMs: 8000 }, { kind: "drop", startMs: 8000, endMs: 16000 }] };
    const timeline = parseTimeline({ version: 1, clips, texts: [], music });
    const plan = planPace(timeline, { energy: 0.75, ramps: true, sourceDurationsMs: Object.fromEntries(clips.map((c) => [c.assetId, 8000])) })!;
    const intro = plan.shots.filter((shot) => shot.section === "intro").map((shot) => plan.clips.find((c) => c.id === shot.clipId)!);
    const driving = plan.shots.filter((shot) => shot.section !== "intro" && !shot.hero).map((shot) => plan.clips.find((c) => c.id === shot.clipId)!);
    expect(intro.length).toBeGreaterThan(0);
    expect(intro.every((clip) => !clip.ramp)).toBe(true);
    expect(driving.length).toBeGreaterThan(0);
    expect(driving.every((clip) => clip.ramp?.preset === "into-cut")).toBe(true);
    // Every cut still lands on the beat: the ramp changes nothing about lengths.
    for (const shot of plan.shots) expect(Math.abs(shot.endMs % period) < 2 || Math.abs((shot.endMs % period) - period) < 2).toBe(true);
    const without = planPace(timeline, { energy: 0.75, sourceDurationsMs: Object.fromEntries(clips.map((c) => [c.assetId, 8000])) })!;
    expect(without.clips.every((clip) => !clip.ramp)).toBe(true);
    expect(without.shots.map((s) => [s.startMs, s.endMs])).toEqual(plan.shots.map((s) => [s.startMs, s.endMs]));
  });
});

describe("eased camera moves", () => {
  it("eases between keys and holds the last", () => {
    expect(easeValue("linear", 0.5)).toBe(0.5);
    expect(easeValue("in", 0.5)).toBe(0.25);
    expect(easeValue("out", 0.5)).toBe(0.75);
    expect(easeValue("in-out", 0.5)).toBe(0.5);
    expect(easeValue("snap", 0.3)).toBeGreaterThan(0.8);
    const push = cameraPreset("push");
    expect(cameraKeysAt(push, 0)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(cameraKeysAt(push, 0.5).scale).toBeCloseTo(1.06, 6);
    expect(cameraKeysAt(push, 1).scale).toBeCloseTo(1.12, 6);
    const settle = cameraPreset("push-settle");
    expect(cameraKeysAt(settle, 0.55).scale).toBeCloseTo(1.15, 6);
    expect(cameraKeysAt(settle, 1).scale).toBeCloseTo(1.12, 6);
  });

  it("snaps closer within the first tenth and holds", () => {
    const snap = cameraPreset("snap");
    expect(cameraKeysAt(snap, 0.03).scale).toBeGreaterThan(1.08);
    expect(cameraKeysAt(snap, 0.1).scale).toBeCloseTo(1.12, 6);
    expect(cameraKeysAt(snap, 0.9).scale).toBeCloseTo(1.12, 6);
  });

  it("is already moving on the opening shot's first frame", () => {
    for (const preset of ["push", "push-settle", "drift", "snap"] as const) {
      const clip = video("a", 0, 3000, { camera: cameraPreset(preset) });
      const first = clipCameraAt(clip, 0, 0, true), next = clipCameraAt(clip, 1 / 90, 1 / 30, true);
      expect(Math.abs(first.scale - next.scale) + Math.abs(first.x - next.x) + Math.abs(first.y - next.y)).toBeGreaterThan(1e-4);
      expect(cameraStillAtStart(cameraPreset(preset))).toBe(false);
    }
    expect(openingProgress(0)).toBeCloseTo(0.1);
    expect(openingProgress(1)).toBe(1);
    // A hand-made move that eases in from a standstill is still at its start, and only then the opening phase moves it.
    const still = { preset: "custom" as const, keys: [{ p: 0, scale: 1, x: 0, y: 0, ease: "in" as const }, { p: 1, scale: 1.2, x: 0, y: 0, ease: "in" as const }] };
    expect(cameraStillAtStart(still)).toBe(true);
    const clip = video("a", 0, 3000, { camera: still });
    expect(clipCameraAt(clip, 0, 0, true).scale).toBeGreaterThan(clipCameraAt(clip, 0, 0, false).scale);
    expect(clipCameraAt(clip, 0, 0, false).scale).toBe(1);
    // A preset is not shifted: the snap happens on the first frames of the opening shot, not before it.
    const snap = video("b", 0, 3000, { camera: cameraPreset("snap") });
    expect(clipCameraAt(snap, 0, 0, true).scale).toBe(1);
    expect(clipCameraAt(snap, 0.05, 0.15, true).scale).toBeGreaterThan(1.1);
  });

  it("keeps the Ken Burns presets byte for byte when a clip has no camera", () => {
    const clip = video("a", 0, 3000, { motion: "zoom-in" });
    expect(clipCameraAt(clip, 0.5, 1.5)).toEqual({ scale: 1.07, x: 0, y: 0 });
    expect(clipCameraAt(video("b", 0, 3000, { motion: "pan" }), 1, 3)).toEqual({ scale: 1.16, x: 5, y: 0 });
    expect(clipCameraAt(video("c", 0, 3000), 0.5, 1, true)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("carries the vertical shift through the view contract both ways", () => {
    const clip = video("a", 0, 3000, { camera: cameraPreset("drift") });
    const picture = clipPicture(clip, { width: 1080, height: 1920 }, { progress: 1, seconds: 3 });
    expect(picture.shiftY).toBeCloseTo(-0.01, 6);
    const [u, v] = sourceToComposition(picture, 540, 960);
    expect(u).toBeCloseTo(0.5 + 1.1 * 0.03, 6);
    expect(v).toBeCloseTo(0.5 - 1.1 * 0.01, 6);
    const [px, py] = compositionToSource(picture, u, v);
    expect(px).toBeCloseTo(540, 4);
    expect(py).toBeCloseTo(960, 4);
    expect(clipPicture(video("b", 0, 3000, { motion: "pan" }), { width: 1080, height: 1920 }, { progress: 0, seconds: 0 }).shiftY).toBe(0);
  });

  it("is set and cleared through the commands", () => {
    const timeline = reel([video("a", 0, 3000)]);
    const set = applyCommand(timeline, { type: "setCamera", clipId: "a", camera: "push-settle" }, { generation: 0 });
    expect(set.timeline.clips[0].camera?.preset).toBe("push-settle");
    expect(applyCommand(set.timeline, { type: "setCamera", clipId: "a", camera: null }, { generation: 0 }).timeline.clips[0].camera).toBeNull();
    expect(applyCommand(timeline, { type: "setCamera", clipId: "a", camera: "orbit" as never }, { generation: 0 }).rejected).toMatch(/no camera move/);
  });
});

/** A textured frame shifted by (sx, sy); `seed` picks a different picture. */
function frame(sx: number, sy: number, seed = 1, width = 48, height = 85): Gray {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const n = Math.sin((x - sx) * 12.9898 + (y - sy) * 78.233 + seed * 37.719) * 43758.5453;
    data[y * width + x] = (n - Math.floor(n)) * 255;
  }
  return { data, width, height };
}
/** Five frames 250 ms apart whose content travels (vx, vy) px per frame. */
const pan = (vx: number, vy: number, seed = 1) => Array.from({ length: 5 }, (_, i) => ({ t: i * 250, gray: frame(vx * i, vy * i, seed) }));

describe("match cuts from measured motion", () => {
  const left = summariseMotion(pan(-3, 0))!, right = summariseMotion(pan(3, 0, 2))!, down = summariseMotion(pan(0, 3, 3))!, still = summariseMotion(pan(0, 0, 4))!;

  it("reads a pan's direction and speed from synthetic flows, and sees no subject in a pan over a still scene", () => {
    expect(left.subject).toBeNull();
    expect(right.subject).toBeNull();
    expect(motionDirection(left.end)).toBe("left");
    expect(motionDirection(right.start)).toBe("right");
    expect(motionDirection(down.end)).toBe("down");
    expect(motionDirection(still.end)).toBeNull();
    expect(left.end.dx).toBeCloseTo(-12, 0); // 3 px per 250 ms
    expect(left.energy).toBeGreaterThan(still.energy);
  });

  it("scores motion that carries across the cut high, a reversal low, and a stop against", () => {
    expect(matchCutScore(left, left)).toBeGreaterThan(0.5);
    expect(matchCutScore(left, right)).toBeLessThan(-0.5);
    expect(matchCutScore(left, down)).toBeCloseTo(0, 1);
    expect(matchCutScore(still, still)).toBe(0);
    expect(matchCutScore(left, still)).toBeLessThan(0);
  });

  it("whips in the camera's direction: content leaving left is a camera panning right", () => {
    expect(whipDirectionFor(left)).toBe("right");
    expect(whipDirectionFor(right)).toBe("left");
    expect(whipDirectionFor(down)).toBe("up");
    expect(whipDirectionFor(still)).toBeNull();
  });

  it("suggests pairs and a chain from the opening shot", () => {
    const motion: Record<string, ClipMotion> = { a: left, b: right, c: left, d: still };
    const timeline = reel([video("a", 0, 2000), video("b", 0, 2000), video("c", 0, 2000), video("d", 0, 2000)]);
    const suggestions = suggestMatchCuts(timeline, motion);
    expect(suggestions.pairs[0]).toMatchObject({ fromId: "a", toId: "c", whip: "right" });
    expect(suggestions.pairs.some((pair) => pair.fromId === "a" && pair.toId === "b")).toBe(false);
    expect(suggestions.order).toEqual(["a", "c", "b", "d"]);
    // A held clip keeps its slot.
    expect(suggestMatchCuts(timeline, motion, { heldClipIds: ["b"] }).order).toEqual(["a", "b", "c", "d"]);
    // Nothing measured: the order is kept and nothing is suggested.
    expect(suggestMatchCuts(timeline, {})).toEqual({ pairs: [], order: ["a", "b", "c", "d"] });
  });

  it("tells the Add media flow after which shots a candidate cuts well", () => {
    const timeline = reel([video("a", 0, 2000), video("b", 0, 2000)]);
    expect(cutsWellAfter(timeline, { a: left, b: right }, left)).toEqual([{ clipId: "a", index: 0, score: matchCutScore(left, left) }]);
    expect(cutsWellAfter(timeline, { a: left, b: right }, down)).toEqual([]);
  });

  it("reorders through one command, as one step, and refuses a retired transition", () => {
    const motion: Record<string, ClipMotion> = { a: left, b: right, c: left };
    const timeline = reel([video("a", 0, 2000), video("b", 0, 2000), video("c", 0, 2000, { transitionIn: "softDissolve" })]);
    const result = applyCommand(timeline, { type: "matchCuts", motion }, { generation: 0 });
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.clips.map((clip) => clip.id)).toEqual(["a", "c", "b"]);
    expect(applyCommand(timeline, { type: "matchCuts", motion, reorder: false }, { generation: 0 }).timeline).toBe(timeline);
    const transition = applyCommand(timeline, { type: "setTransition", clipId: "c", transition: "focusPull" }, { generation: 0 });
    expect(transition.timeline.clips[2].transitionIn).toBe("focusPull");
    const retired = applyCommand(timeline, { type: "setTransition", clipId: "c", transition: "whip" as never }, { generation: 0 });
    expect(retired.rejected).toMatch(/retired/);
  });
});

describe("ramp into cuts with Energy, and the commands over HTTP", () => {
  const clips = Array.from({ length: 6 }, (_, i) => video(`c${i}`, 0, 8000, { volume: 0 }));
  const music = { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 120, beatOffsetMs: 0, downbeats: [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000],
    sections: [{ kind: "intro", startMs: 0, endMs: 4000 }, { kind: "build", startMs: 4000, endMs: 8000 }, { kind: "drop", startMs: 8000, endMs: 16000 }] };
  const timeline = parseTimeline({ version: 1, clips, texts: [], music });
  const context = { generation: 0, sourceDurationsMs: Object.fromEntries(clips.map((c) => [c.assetId, 8000])) };

  it("remembers Ramp into cuts on the music, keeps it on later Energy changes, and takes its ramps back when switched off", () => {
    const on = applyCommand(timeline, { type: "pace", energy: 0.75, ramps: true }, context);
    expect(on.timeline.music?.ramps).toBe(true);
    expect(on.timeline.clips.some((clip) => clip.ramp?.preset === "into-cut")).toBe(true);
    const again = applyCommand(on.timeline, { type: "pace", energy: 0.5 }, context);
    expect(again.timeline.music?.ramps).toBe(true);
    expect(again.timeline.clips.some((clip) => clip.ramp?.preset === "into-cut")).toBe(true);
    const off = applyCommand(again.timeline, { type: "pace", energy: 0.5, ramps: false }, context);
    expect(off.timeline.music?.ramps).toBe(false);
    expect(off.timeline.clips.every((clip) => !clip.ramp)).toBe(true);
    // A reel never paced with ramps has none, as before.
    expect(applyCommand(timeline, { type: "pace", energy: 0.75 }, context).timeline.clips.every((clip) => !clip.ramp)).toBe(true);
  });

  it("runs the motion commands as one batch and refuses a command it does not know", () => {
    const motion: Record<string, ClipMotion> = { c0: summariseMotion(pan(-3, 0))!, c1: summariseMotion(pan(3, 0, 2))!, c2: summariseMotion(pan(-3, 0, 5))! };
    const result = applyCommand(timeline, { type: "batch", commands: [
      { type: "setRamp", clipId: "c0", ramp: "hold-snap" },
      { type: "setCamera", clipId: "c1", camera: "drift" },
      { type: "setTransition", clipId: "c1", transition: "softDissolve" },
      { type: "matchCuts", motion, reorder: false },
    ] }, context);
    expect(result.rejected).toBeUndefined();
    const byId = Object.fromEntries(result.timeline.clips.map((clip) => [clip.id, clip]));
    expect(byId.c0.ramp?.preset).toBe("hold-snap");
    expect(byId.c1.camera?.preset).toBe("drift");
    expect(byId.c1.transitionIn).toBe("softDissolve");
    expect(result.changes).toEqual(expect.arrayContaining([{ kind: "clip", id: "c0" }, { kind: "clip", id: "c1" }]));
    // One bad step refuses the whole batch; an unknown command is refused rather than passed as "no change".
    const bad = applyCommand(timeline, { type: "batch", commands: [{ type: "setRamp", clipId: "c0", ramp: "hit" }, { type: "setCamera", clipId: "nope", camera: "push" }] }, context);
    expect(bad.rejected).toBeTruthy();
    expect(bad.timeline).toBe(timeline);
    expect(applyCommand(timeline, { type: "fly" } as never, context).rejected).toMatch(/no command called fly/);
  });
});
