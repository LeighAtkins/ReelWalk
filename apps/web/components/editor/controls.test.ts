import { describe, expect, it } from "vitest";
import { parseTimeline, type Timeline } from "@reelwalk/core";
import { BUILT_IN_CONTROLS, controlsFor, isPresenterClip, targetsFor, type ControlContext, type ControlSpec } from "./controls";
import { replaceClipSource } from "./replace-clip";

// Tap the thing (ADR 0064): what each selection reaches, from one registry.

const reel = (): Timeline =>
  parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 6000 },
      { id: "b", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
      { id: "c", assetId: "pano", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 5000, pano: { yawStart: -45, yawEnd: 45 } },
    ],
    texts: [
      { id: "hook", text: "Just listed", startMs: 0, endMs: 2000 },
      { id: "kitchen", text: "Kitchen", startMs: 4500, endMs: 6000, pin: { assetId: "p1", fromMs: 0, toMs: 1500 }, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.1, y: 0 }] },
    ],
    music: null,
  });

const context = (patch: Partial<ControlContext> = {}): ControlContext => ({ timeline: reel(), clip: null, clipIndex: -1, text: null, asset: null, askAvailable: true, instagram: false, ...patch });
const ids = (targets: Parameters<typeof controlsFor>[0], ctx: ControlContext, place: "bar" | "more" = "bar") => controlsFor(targets, ctx).filter((c) => c.place === place).map((c) => c.id);

describe("what a tap reaches", () => {
  it("nothing selected: a short bar (add, two finishes, Reel) and the reel-wide rest in the Reel sheet", () => {
    expect(ids(["reel"], context())).toEqual(["text-new", "music-open", "media", "finish-pop", "finish-premium", "reel-more"]);
    const more = ids(["reel"], context(), "more");
    for (const id of ["pace", "look-all", "words", "hook", "details", "caption", "logo", "ai-video", "director", "split", "guides", "delete-reel"]) expect(more).toContain(id);
    // The floor plan only when the reel has one; the director only where AI is set up.
    expect(more).not.toContain("plan");
    expect(ids(["reel"], context({ askAvailable: false }), "more")).not.toContain("director");
  });

  it("a video clip: trim, speed, zoom and replace lead; the first shot also reaches the hook", () => {
    const timeline = reel();
    const ctx = context({ clip: timeline.clips[0], clipIndex: 0, asset: { kind: "VIDEO", isPano: false } });
    const bar = controlsFor(["clip"], ctx);
    expect(bar.slice(0, 5).map((c) => c.id)).toEqual(["trim", "speed", "zoom", "replace", "hook"]);
    expect(bar[0].label).toBe("Trim");
    expect(bar.map((c) => c.id)).toEqual(expect.arrayContaining(["split", "volume", "motion", "look", "cover", "fit", "transition", "duplicate", "earlier", "later"]));
  });

  it("a photo has Length, no speed or volume; a 360 photo has its view and no motion", () => {
    const timeline = reel();
    const photo = controlsFor(["clip"], context({ clip: timeline.clips[1], clipIndex: 1, asset: { kind: "IMAGE", isPano: false } }));
    expect(photo[0].label).toBe("Length");
    expect(photo.map((c) => c.id)).not.toEqual(expect.arrayContaining(["speed"]));
    expect(photo.map((c) => c.id)).not.toContain("hook");
    const pano = controlsFor(["clip"], context({ clip: timeline.clips[2], clipIndex: 2, asset: { kind: "IMAGE", isPano: true } })).map((c) => c.id);
    expect(pano).toContain("pano");
    expect(pano).not.toContain("motion");
  });

  it("the presenter's controls come before the clip's", () => {
    expect(targetsFor({ kind: "clip" }, true)).toEqual(["presenter", "clip"]);
    // A script's take, or a take composed with her kit; AI b-roll is an ordinary clip.
    expect(isPresenterClip("script-ai-123", null)).toBe(true);
    expect(isPresenterClip("c1", { isPresenterTake: true })).toBe(true);
    expect(isPresenterClip("ai-insert-ai-9", { isPresenterTake: false })).toBe(false);
    expect(isPresenterClip("c1", undefined)).toBe(false);
    const timeline = reel();
    const bar = controlsFor(targetsFor({ kind: "clip" }, true), context({ clip: timeline.clips[0], clipIndex: 0, asset: { kind: "VIDEO", isPano: false, isPresenterTake: true } }));
    expect(bar.slice(0, 3).map((c) => c.id)).toEqual(["redo-take", "new-take", "trim"]);
  });

  it("a title: style, particles, walk-through, pin, timing; the opening title also reaches the hook", () => {
    const timeline = reel();
    expect(ids(["text"], context({ text: timeline.texts[0] }))).toEqual(["text-edit", "particles", "walk-through", "pin", "timing", "hook", "guides"]);
    expect(ids(["text"], context({ text: timeline.texts[1] }))).not.toContain("hook");
    // A callout (ADR 0061) brings its words in itself: no particles or walk-through.
    const callout = ids(["text"], context({ text: { ...timeline.texts[1], callout: { x: 0.4, y: 0.6 } } }));
    expect(callout).not.toContain("particles");
    expect(callout).not.toContain("walk-through");
  });

  it("an extension mounts on the thing it affects, only when it applies", () => {
    const motion: ControlSpec = { id: "motion-graphics", label: "Motion", targets: ["text"], order: 25, when: (c) => c.text?.id === "kitchen", owner: "W16" };
    const timeline = reel();
    const specs = [...BUILT_IN_CONTROLS, motion];
    expect(controlsFor(["text"], context({ text: timeline.texts[1] }), specs).map((c) => c.id)).toContain("motion-graphics");
    expect(controlsFor(["text"], context({ text: timeline.texts[0] }), specs).map((c) => c.id)).not.toContain("motion-graphics");
    expect(controlsFor(["text"], context({ text: timeline.texts[1] }), specs).find((c) => c.id === "motion-graphics")?.owner).toBe("W16");
  });

  it("no id shows twice and every bar fits a phone without more than one swipe", () => {
    const timeline = reel();
    for (const ctx of [context(), context({ text: timeline.texts[0] }), context({ clip: timeline.clips[0], clipIndex: 0, asset: { kind: "VIDEO", isPano: false } })]) {
      const all = controlsFor(["presenter", "clip", "text", "reel"], ctx).map((c) => c.id);
      expect(new Set(all).size).toBe(all.length);
    }
    expect(ids(["reel"], context()).length).toBeLessThanOrEqual(6);
  });
});

describe("replaceClipSource", () => {
  it("keeps the clip's id, place and length, and drops a pin made on the old picture", () => {
    const before = reel();
    const after = replaceClipSource(before, "b", { id: "v2", kind: "VIDEO", isPano: false, durationMs: 20000 });
    const clip = after.clips[1];
    expect(clip).toMatchObject({ id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, room: null, spot: null });
    const kitchen = after.texts.find((text) => text.id === "kitchen")!;
    expect(kitchen.pin).toBeUndefined();
    expect(kitchen.path).toBeUndefined();
    expect([kitchen.startMs, kitchen.endMs]).toEqual([4500, 6000]);
  });

  it("a shorter source gives a shorter clip; a 360 photo gets its sweep; the same media changes nothing", () => {
    const before = reel();
    expect(replaceClipSource(before, "a", { id: "v9", kind: "VIDEO", isPano: false, durationMs: 1500 }).clips[0].sourceEndMs).toBe(1500);
    expect(replaceClipSource(before, "a", { id: "pano2", kind: "IMAGE", isPano: true, durationMs: null }).clips[0]).toMatchObject({ kind: "IMAGE", motion: "none", pano: { yawStart: -45 } });
    expect(replaceClipSource(before, "a", { id: "v1", kind: "VIDEO", isPano: false, durationMs: 20000 })).toBe(before);
    expect(replaceClipSource(before, "zzz", { id: "v2", kind: "VIDEO", isPano: false, durationMs: 20000 })).toBe(before);
  });
});
