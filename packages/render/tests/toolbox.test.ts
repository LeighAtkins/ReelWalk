import { describe, expect, it } from "vitest";
import { END_CARD_REVEALS, framePlan, parseTimeline, TEXT_ANIMATIONS, titleArrival, TRANSITIONS } from "@reelwalk/core";
import { maskCss, REST, revealAmount, revealFrames, revealStyle, TITLE_REVEALS } from "../src/reel/toolbox/title-reveal";
import { FOCUS_PULL_BLUR, focusPullStyle, SOFT_DISSOLVE_SCALE, softDissolveStyle } from "../src/reel/toolbox/presentations";
import { LIGHT_LEAK_FRAMES_30, lightLeakOverlays } from "../src/reel/toolbox/cut-overlays";
import { lineReveal } from "../src/reel/toolbox/EndCards";
import { leakProgress, LIGHT_LEAK_LOOK } from "../src/reel/toolbox/LightLeak";
import { lowerThirdAt } from "../src/reel/toolbox/LocationLowerThird";
import { isTitleReveal } from "../src/reel/toolbox/RevealFace";

/**
 * The Remotion toolbox (ADR 0082): the new kinds in the schema, the title reveals, the two CSS presentations, the
 * light-leak overlays and the end card's reveals, as numbers. What they look like is the gallery's.
 */
const FPS = 30;

describe("the schema", () => {
  it("offers only the owner's kinds (2026-10-26)", () => {
    expect(TRANSITIONS).toEqual(["cut", "fade", "walk", "softDissolve", "focusPull", "lightLeak"]);
    expect(TEXT_ANIMATIONS).toEqual(expect.arrayContaining(["auto", "pop", "fade", "rise", "type", "none", ...TITLE_REVEALS]));
    expect(END_CARD_REVEALS).toEqual(["cut", "leak"]);
    for (const reveal of TITLE_REVEALS) expect(isTitleReveal(reveal)).toBe(true);
    expect(isTitleReveal("fade")).toBe(false);
  });

  it("defaults: a cut, the elegant serif tracks in (the owner's pick), and a card with no reveal is the hard cut", () => {
    const timeline = parseTimeline({
      version: 1,
      clips: [{ id: "a", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 }],
      texts: [{ id: "t", text: "Live above it all", startMs: 0, endMs: 2000, style: "elegant" }],
      music: null,
      endCard: { text: "ReelWalk", durationMs: 2000 },
    });
    expect(timeline.clips[0].transitionIn).toBe("cut");
    expect(timeline.texts[0].animation).toBe("auto");
    expect(titleArrival(timeline.texts[0])).toBe("trackIn");
    expect(titleArrival({ ...timeline.texts[0], style: "headline" })).toBe("pop");
    expect(titleArrival({ ...timeline.texts[0], animation: "fadeQuick" })).toBe("fadeQuick");
    expect(timeline.endCard?.reveal).toBeUndefined();
  });

  it("accepts the new kinds and refuses unknown ones", () => {
    const base = { version: 1, texts: [], music: null };
    const clips = [
      { id: "a", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
      { id: "b", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000, transitionIn: "lightLeak" },
    ];
    expect(parseTimeline({ ...base, clips, endCard: { text: "R", durationMs: 2000, reveal: "leak" } }).endCard?.reveal).toBe("leak");
    expect(() => parseTimeline({ ...base, clips: [clips[0], { ...clips[1], transitionIn: "filmBurn" }] })).toThrow();
    expect(() => parseTimeline({ ...base, clips, endCard: { text: "R", durationMs: 2000, reveal: "bounce" } })).toThrow();
  });
});

describe("title reveals", () => {
  const D = 75;

  it("are hidden before the first frame, at rest in the middle and gone on the last", () => {
    for (const reveal of TITLE_REVEALS) {
      expect(revealAmount(reveal, -1, FPS, D)).toBe(0);
      expect(revealStyle(reveal, Math.floor(D / 2), FPS, D)).toEqual(REST);
      expect(revealAmount(reveal, D, FPS, D)).toBe(0);
    }
  });

  it("take the lengths in the ADR: 200 ms fades, a 6-frame mask, a 0.8 s tracking and a 0.6 s blur", () => {
    expect(revealFrames("fadeQuick", FPS, D)).toEqual({ enter: 6, exit: 6 });
    expect(revealFrames("maskUp", FPS, D)).toEqual({ enter: 6, exit: 5 });
    expect(revealFrames("trackIn", FPS, D)).toEqual({ enter: 24, exit: 8 });
    expect(revealFrames("blurIn", FPS, D)).toEqual({ enter: 18, exit: 8 });
    // A short title never spends more than a third of itself on either side.
    expect(revealFrames("trackIn", FPS, 30)).toEqual({ enter: 10, exit: 8 });
    expect(revealFrames("fadeQuick", 60, D)).toEqual({ enter: 12, exit: 12 });
  });

  it("move only one way each: the fade fades, the mask never fades, tracking and blur only close", () => {
    let lastTracking = Infinity, lastBlur = Infinity;
    for (let f = 0; f <= 24; f++) {
      const fade = revealStyle("fadeQuick", f, FPS, D);
      expect([fade.trackingEm, fade.blurPx, fade.maskBottom, fade.offsetY]).toEqual([0, 0, 0, 0]);
      const mask = revealStyle("maskUp", f, FPS, D);
      expect(mask.opacity === 1 || mask.maskBottom === 1).toBe(true);
      const track = revealStyle("trackIn", f, FPS, D);
      expect(track.trackingEm).toBeLessThanOrEqual(lastTracking);
      lastTracking = track.trackingEm;
      const blur = revealStyle("blurIn", f, FPS, D);
      expect(blur.blurPx).toBeLessThanOrEqual(lastBlur);
      expect(blur.offsetY).toBeGreaterThanOrEqual(0);
      lastBlur = blur.blurPx;
    }
    expect(revealStyle("trackIn", 0, FPS, D).trackingEm).toBeCloseTo(0.18, 6);
    expect(revealStyle("blurIn", 0, FPS, D).blurPx).toBeCloseTo(8, 6);
    expect(revealStyle("maskUp", 6, FPS, D)).toEqual(REST);
  });

  it("the mask clips only while it is opening", () => {
    expect(maskCss(REST)).toEqual({ outer: {}, innerTranslatePct: 0 });
    expect(maskCss(revealStyle("maskUp", 0, FPS, D))).toEqual({ outer: { overflow: "hidden" }, innerTranslatePct: 100 });
    const mid = maskCss(revealStyle("maskUp", 3, FPS, D));
    expect(mid.innerTranslatePct).toBeGreaterThan(0);
    expect(mid.innerTranslatePct).toBeLessThan(50);
  });
});

describe("presentations", () => {
  it("soft dissolve: a crossfade whose scale breathes by at most 3 %", () => {
    expect(softDissolveStyle("entering", 0)).toEqual({ opacity: 0, scale: 1 - SOFT_DISSOLVE_SCALE });
    expect(softDissolveStyle("entering", 1)).toEqual({ opacity: 1, scale: 1 });
    expect(softDissolveStyle("exiting", 0)).toEqual({ opacity: 1, scale: 1 });
    expect(softDissolveStyle("exiting", 1)).toEqual({ opacity: 0, scale: 1 + SOFT_DISSOLVE_SCALE });
    for (const p of [0.25, 0.5, 0.75]) expect(softDissolveStyle("entering", p).opacity + softDissolveStyle("exiting", p).opacity).toBeCloseTo(1, 9);
  });

  it("focus pull: sharp at both ends, never past its blur, the incoming shot over the outgoing one by the end", () => {
    expect(focusPullStyle("exiting", 0)).toMatchObject({ opacity: 1, scale: 1, blur: 0, brightness: 1 });
    expect(focusPullStyle("entering", 1)).toMatchObject({ opacity: 1, scale: 1, blur: 0, brightness: 1 });
    for (let p = 0; p <= 1; p += 0.05) {
      expect(focusPullStyle("exiting", p).blur).toBeLessThanOrEqual(FOCUS_PULL_BLUR + 1e-9);
      expect(focusPullStyle("entering", p).blur).toBeLessThanOrEqual(FOCUS_PULL_BLUR + 1e-9);
    }
    expect(focusPullStyle("exiting", 0.7).opacity).toBe(0);
    expect(focusPullStyle("entering", 0.52).opacity).toBe(1);
  });
});

describe("light leaks over cuts", () => {
  const clip = (id: string, transitionIn: string, ms = 2000) => ({ id, assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: ms, transitionIn });

  it("centre one on each lightLeak cut and leave the cut where it was", () => {
    const timeline = parseTimeline({ version: 1, clips: [clip("a", "cut"), clip("b", "lightLeak"), clip("c", "cut"), clip("d", "lightLeak")], texts: [], music: null });
    const plan = framePlan(timeline, FPS);
    const leaks = lightLeakOverlays(plan.clips, FPS, plan.totalFrames);
    expect(leaks.map((l) => l.clipId)).toEqual(["b", "d"]);
    expect(leaks[0]).toEqual({ clipId: "b", from: 60 - LIGHT_LEAK_FRAMES_30 / 2, durationInFrames: LIGHT_LEAK_FRAMES_30 });
    expect(plan.clips.map((c) => c.from)).toEqual([0, 60, 120, 180]);
  });

  it("shorten next to a very short clip, and never on the opening shot", () => {
    const timeline = parseTimeline({ version: 1, clips: [clip("a", "lightLeak", 200), clip("b", "lightLeak", 2000)], texts: [], music: null });
    const plan = framePlan(timeline, FPS);
    const leaks = lightLeakOverlays(plan.clips, FPS, plan.totalFrames);
    expect(leaks).toEqual([{ clipId: "b", from: 0, durationInFrames: 12 }]);
  });
});

describe("end card reveals", () => {
  it("the cut's line is simply there; the leak's resolves out of a blur after the glint peaks", () => {
    expect(lineReveal("cut", 0, FPS)).toBeNull();
    expect(lineReveal("leak", 0, FPS)?.opacity).toBe(0);
    expect(lineReveal("leak", 40, FPS)).toEqual(REST);
  });
  it("the glint is toned down: under half strength, amber, and never opened to a full-frame wash", () => {
    expect(LIGHT_LEAK_LOOK.strength).toBeLessThanOrEqual(0.5);
    expect(LIGHT_LEAK_LOOK.hueShift).toBeGreaterThan(0);
    expect(LIGHT_LEAK_LOOK.hueShift).toBeLessThan(25);
    expect(LIGHT_LEAK_LOOK.peak).toBeLessThan(1);
    // It opens to peak × 0.5 in the middle and closes again; the effect's full sweep (0 to 1) only when peak is 1.
    expect(leakProgress(0, 19, 0.75)).toBe(0);
    expect(leakProgress(9, 19, 0.75)).toBeCloseTo(0.375, 9);
    expect(leakProgress(18, 19, 0.75)).toBe(0);
    expect(leakProgress(18, 19, 1)).toBe(1);
  });
});

describe("the location lower third (Remotion Elements' curves)", () => {
  it("draws the pin first, reveals the line from the left, and leaves in reverse", () => {
    const D = 90;
    expect(lowerThirdAt(0, D)).toMatchObject({ pinOpacity: 0, dashOffset: 1, cropRight: 1, textOpacity: 0 });
    const mid = lowerThirdAt(45, D);
    expect(mid).toMatchObject({ pinOpacity: 1, pinY: 0, pinScale: 1, fillOpacity: 1, dashOffset: 0, dotR: 9, textOpacity: 1 });
    // The overdamped spring is all but settled by the middle.
    expect(mid.cropRight).toBeLessThan(0.01);
    // The line starts after the pin has begun (frame 14): before it nothing of the text shows.
    expect(lowerThirdAt(10, D).textOpacity).toBe(0);
    expect(lowerThirdAt(D - 1, D).pinOpacity).toBe(0);
  });
  it("compresses its timings on a short title instead of breaking", () => {
    for (const D of [10, 30, 45, 71]) {
      expect(() => lowerThirdAt(0, D)).not.toThrow();
      expect(lowerThirdAt(Math.round(D / 2), D).textOpacity).toBeGreaterThan(0.9);
    }
  });
});

describe("the toolbox's overlaps in the TransitionSeries (ADR 0083's join)", () => {
  it("centres softDissolve and focusPull on the saved cut, 12 frames each; lightLeak stays a cut with an overlay", async () => {
    const { planCuts } = await import("../src/reel/transition-plan");
    const { presentationOf } = await import("../src/reel/transitions");
    const { focusPull, softDissolve } = await import("../src/reel/toolbox/presentations");
    const entry = (transitionIn: string) => ({ clip: { transitionIn: transitionIn as never }, durationInFrames: 60 });
    const cuts = planCuts([entry("cut"), entry("softDissolve"), entry("focusPull"), entry("lightLeak")], FPS);
    expect(cuts[1]).toEqual({ kind: "softDissolve", frames: 12, before: 6, after: 6 });
    expect(cuts[2]).toEqual({ kind: "focusPull", frames: 12, before: 6, after: 6 });
    expect(cuts[3]).toEqual({ kind: "none" });
    expect(presentationOf(cuts[1] as never).component).toBe(softDissolve().component);
    expect(presentationOf(cuts[2] as never).component).toBe(focusPull().component);
  });
});
