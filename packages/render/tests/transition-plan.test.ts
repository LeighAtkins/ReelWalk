import { describe, expect, it } from "vitest";
import { TRANSITIONS, type Clip } from "@reelwalk/core";
import { clipSpans, cutProgressAt, mediaHandles, planCuts, presentationFor, transitionFrames, type CutPlan } from "../src/reel/transition-plan";

const entry = (transitionIn: Clip["transitionIn"], durationInFrames = 60) => ({ clip: { transitionIn }, durationInFrames });

describe("the schema's transition kinds as Remotion presentations (ADR 0083)", () => {
  it("maps every kind the schema has", () => {
    const mapped = Object.fromEntries(TRANSITIONS.map((kind) => [kind, presentationFor(kind)]));
    expect(mapped).toEqual({ cut: "none", fade: "fade", walk: "none", softDissolve: "softDissolve", focusPull: "focusPull", lightLeak: "none" });
  });

  it("keeps transitions short: 10 frames for a fade and 12 for a soft dissolve at 30 fps, never over 12 frames' worth", () => {
    expect(transitionFrames("fade", 30)).toBe(10);
    expect(transitionFrames("softDissolve", 30)).toBe(12);
    expect(transitionFrames("fade", 60)).toBe(20);
    expect(transitionFrames("fade", 24)).toBeLessThanOrEqual(Math.round((12 * 24) / 30));
    expect(transitionFrames("focusPull", 1)).toBe(2);
  });
});

describe("planCuts", () => {
  it("centres each transition on the saved cut", () => {
    const cuts = planCuts([entry("cut"), entry("fade"), entry("focusPull"), entry("lightLeak"), entry("cut")], 30);
    expect(cuts[0]).toEqual({ kind: "none" });
    expect(cuts[1]).toEqual({ kind: "fade", frames: 10, before: 5, after: 5 });
    expect(cuts[2]).toEqual({ kind: "focusPull", frames: 12, before: 6, after: 6 });
    expect(cuts[3]).toEqual({ kind: "none" });
    expect(cuts[4]).toEqual({ kind: "none" });
  });

  it("never draws the opening shot's fade as a transition (it is a fade from black inside the clip)", () => {
    expect(planCuts([entry("fade")], 30)).toEqual([{ kind: "none" }]);
  });

  it("shortens a transition next to a short clip, and drops it to a cut when it cannot fit", () => {
    const cuts = planCuts([entry("cut", 4), entry("fade", 3), entry("fade", 60)], 30);
    expect(cuts[1]).toEqual({ kind: "fade", frames: 3, before: 2, after: 1 });
    // The 3-frame clip gives each neighbouring half at most 1 frame.
    expect(cuts[2]).toEqual({ kind: "fade", frames: 6, before: 1, after: 5 });
    expect(planCuts([entry("cut", 1), entry("fade", 1)], 30)[1]).toEqual({ kind: "none" });
  });

  it("never lets a clip's two transitions overlap, so the series is always valid", () => {
    for (const d of [1, 2, 3, 5, 8, 9, 13, 30]) {
      const plan = [entry("cut", d), entry("fade", d), entry("softDissolve", d), entry("fade", d)];
      const cuts = planCuts(plan, 30);
      const spans = clipSpans(cuts);
      plan.forEach((clip, i) => {
        const into = cuts[i].kind === "none" ? 0 : (cuts[i] as Extract<CutPlan, { before: number }>).after;
        const out = cuts[i + 1] && cuts[i + 1].kind !== "none" ? (cuts[i + 1] as Extract<CutPlan, { before: number }>).before : 0;
        expect(into + out).toBeLessThanOrEqual(clip.durationInFrames);
        // Remotion's rule: a transition is no longer than either sequence it joins.
        const sequence = spans[i].lead + clip.durationInFrames + spans[i].tail;
        if (cuts[i].kind !== "none") expect((cuts[i] as Extract<CutPlan, { frames: number }>).frames).toBeLessThanOrEqual(sequence);
        if (cuts[i + 1] && cuts[i + 1].kind !== "none") expect((cuts[i + 1] as Extract<CutPlan, { frames: number }>).frames).toBeLessThanOrEqual(sequence);
      });
    }
  });
});

describe("clipSpans", () => {
  it("adds back exactly what the transitions overlap, so the reel's length and every cut stay put", () => {
    const plan = [entry("cut", 61), entry("fade", 45), entry("softDissolve", 90), entry("cut", 30), entry("fade", 75)];
    const cuts = planCuts(plan, 30);
    const spans = clipSpans(cuts);
    const sequences = plan.map((clip, i) => spans[i].lead + clip.durationInFrames + spans[i].tail);
    const overlaps = cuts.reduce((sum, cut) => sum + (cut.kind === "none" ? 0 : cut.frames), 0);
    expect(sequences.reduce((a, b) => a + b, 0) - overlaps).toBe(plan.reduce((sum, clip) => sum + clip.durationInFrames, 0));
    // Each series sequence starts `lead` frames before its saved start.
    let start = 0, saved = 0;
    plan.forEach((clip, i) => {
      if (i > 0) start -= cuts[i].kind === "none" ? 0 : (cuts[i] as Extract<CutPlan, { frames: number }>).frames;
      expect(start + spans[i].lead).toBe(saved);
      start += sequences[i];
      saved += clip.durationInFrames;
    });
  });
});

describe("cutProgressAt", () => {
  const cut: CutPlan = { kind: "fade", frames: 10, before: 5, after: 5 };
  const linear = (frame: number, frames: number) => frame / frames;
  it("is null outside the window and runs across it centred on the cut", () => {
    expect(cutProgressAt(cut, 100, 94, linear)).toBeNull();
    expect(cutProgressAt(cut, 100, 95, linear)).toBe(0);
    expect(cutProgressAt(cut, 100, 100, linear)).toBe(0.5);
    expect(cutProgressAt(cut, 100, 104, linear)).toBe(0.9);
    expect(cutProgressAt(cut, 100, 105, linear)).toBeNull();
    expect(cutProgressAt({ kind: "none" }, 100, 100, linear)).toBeNull();
  });
});

describe("mediaHandles", () => {
  const video = { kind: "VIDEO" as const, speed: 1, sourceStartMs: 1000, ramp: undefined };
  it("plays real footage either side when the source reaches that far", () => {
    expect(mediaHandles(video, 10_000, 60, 5, 4, 30)).toEqual({ pre: 5, post: 4 });
  });
  it("holds a frame where the source has nothing to lend", () => {
    expect(mediaHandles({ ...video, sourceStartMs: 0 }, 10_000, 60, 5, 4, 30)).toEqual({ pre: 0, post: 4 });
    expect(mediaHandles(video, 3000, 60, 5, 4, 30)).toEqual({ pre: 5, post: 0 });
    expect(mediaHandles(video, null, 60, 5, 4, 30)).toEqual({ pre: 5, post: 0 });
  });
  it("never borrows for a photo or a ramp", () => {
    expect(mediaHandles({ ...video, kind: "IMAGE" }, 10_000, 60, 5, 4, 30)).toEqual({ pre: 0, post: 0 });
    expect(mediaHandles({ ...video, ramp: { preset: "hit" } as never }, 10_000, 60, 5, 4, 30)).toEqual({ pre: 0, post: 0 });
  });
  it("counts source time at the clip's speed", () => {
    // At 2× five frames are 333 ms of source: a 300 ms start cannot lend them.
    expect(mediaHandles({ ...video, speed: 2, sourceStartMs: 300 }, 10_000, 60, 5, 0, 30).pre).toBe(0);
    expect(mediaHandles({ ...video, speed: 2, sourceStartMs: 400 }, 10_000, 60, 5, 0, 30).pre).toBe(5);
  });
});
