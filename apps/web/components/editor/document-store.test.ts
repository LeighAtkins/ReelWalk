import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTimeline, type Timeline } from "@reelwalk/core";
import { createDocumentStore } from "./document-store";

// The editor's document as the editor drives it (ADR 0048): history entries,
// gesture baselines, generations and stale proposals, through the store the
// useDocument hook renders.

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
    ],
    texts: [{ id: "t", text: "Hall", startMs: 2500, endMs: 3500 }],
    music: null,
  });
}
const durations = () => ({ v1: 20000, v2: 20000 });
const title = (store: ReturnType<typeof createDocumentStore>) => {
  const text = store.getState().history.present.texts.find((item) => item.id === "t")!;
  return [text.startMs, text.endMs];
};
const trimA = (sourceEndMs: number) => ({ type: "trimClip" as const, clipId: "a", window: { sourceStartMs: 0, sourceEndMs } });

afterEach(() => vi.useRealTimers());

describe("one history entry per action", () => {
  it("a command is one entry; a refused or no-op one is none", () => {
    const store = createDocumentStore(reel(), durations);
    store.runCommand({ type: "moveClip", clipId: "b", toIndex: 0 });
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().generation).toBe(1);
    store.runCommand({ type: "moveClip", clipId: "b", toIndex: 0 });
    store.runCommand({ type: "applyProposal", baseGeneration: 99, proposal: reel() });
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().generation).toBe(1);
  });

  it("an Instagram sound fetched first and applied with its beat snap is one entry, undone in one step", async () => {
    const store = createDocumentStore(reel(), durations);
    const fetchSound = () => new Promise<{ assetId: string; sourceStartMs: number; bpm: number; beatOffsetMs: number }>((resolve) => setTimeout(() => resolve({ assetId: "song", sourceStartMs: 0, bpm: 97, beatOffsetMs: 120 }), 5));
    const music = await fetchSound();
    const result = store.runCommand({ type: "setMusic", music, snap: true });
    expect(result.changes).toContainEqual({ kind: "music" });
    expect(store.getState().history.past).toHaveLength(1);
    store.dispatch({ type: "undo" });
    expect(store.getState().history.present).toEqual(reel());
  });

  it("a command that cannot apply reports why and adds nothing", () => {
    const store = createDocumentStore(reel(), durations);
    const result = store.runCommand({ type: "applyProposal", baseGeneration: 0, proposal: { version: 2 } });
    expect(result.rejected).toBeTruthy();
    expect(store.getState().history.past).toHaveLength(0);
  });
});

describe("gesture baselines live as long as their undo step", () => {
  it("steps of one drag anchor to the reel before the drag", () => {
    const store = createDocumentStore(reel(), durations);
    store.runCommand(trimA(2000), "drag:a:1");
    expect(title(store)[1]).toBeLessThanOrEqual(2000);
    store.runCommand(trimA(4000), "drag:a:1");
    expect(title(store)).toEqual([2500, 3500]);
    expect(store.getState().history.past).toHaveLength(1);
  });

  it("a later action with the same key, after the merge window, starts from where the first left off", () => {
    vi.useFakeTimers();
    const store = createDocumentStore(reel(), durations);
    store.runCommand(trimA(2000), "trim-a");
    const squeezed = title(store);
    vi.advanceTimersByTime(2000);
    store.runCommand(trimA(4000), "trim-a");
    // Its own undo step, anchored to the squeezed title, not to the first action's baseline.
    expect(store.getState().history.past).toHaveLength(2);
    expect(title(store)).toEqual(squeezed);
  });

  it("a Trim sheet slider paused mid-gesture stays one step with one baseline (drag: key per sheet opening)", () => {
    vi.useFakeTimers();
    const spanning = parseTimeline({ ...reel(), texts: [{ id: "cap", text: "Just listed", startMs: 3000, endMs: 7500 }] });
    const store = createDocumentStore(spanning, durations);
    const key = "drag:trim-a:1000";
    store.runCommand(trimA(1500), key);
    expect(store.getState().history.present.texts[0].endMs).toBe(5500);
    vi.advanceTimersByTime(900);
    store.runCommand(trimA(4000), key);
    expect(store.getState().history.present.texts[0]).toMatchObject({ startMs: 3000, endMs: 7500 });
    expect(store.getState().history.past).toHaveLength(1);
  });

  it("closing the sheet ends the gesture", () => {
    const store = createDocumentStore(reel(), durations);
    store.runCommand(trimA(2000), "trim-a");
    const squeezed = title(store);
    store.endGesture();
    store.runCommand(trimA(4000), "trim-a");
    expect(title(store)).toEqual(squeezed);
  });

  it("undo and redo end the gesture, even when redo brings back the same reel", () => {
    const store = createDocumentStore(reel(), durations);
    store.runCommand(trimA(2000), "trim-a");
    const squeezed = title(store);
    store.dispatch({ type: "undo" });
    store.dispatch({ type: "redo" });
    store.runCommand(trimA(4000), "trim-a");
    expect(title(store)).toEqual(squeezed);
    expect(store.getState().history.past).toHaveLength(2);
  });
});

describe("async proposals", () => {
  it("a proposal that completes after an edit and its undo is stale", async () => {
    const store = createDocumentStore(reel(), durations);
    const asked = store.snapshot();
    const proposal = { ...asked.timeline, clips: [...asked.timeline.clips].reverse() };
    store.runCommand({ type: "moveClip", clipId: "b", toIndex: 0 });
    store.dispatch({ type: "undo" });
    // The reel looks as it did when asked, but it changed in between: the studio reviews instead.
    expect(store.getState().history.present).toEqual(asked.timeline);
    const late = await Promise.resolve(store.runCommand({ type: "applyProposal", baseGeneration: asked.generation, proposal }));
    expect(late.stale).toBe(true);
    expect(store.getState().history.present.clips.map((clip) => clip.id)).toEqual(["a", "b"]);
  });

  it("a proposal against the current generation lands as one entry and returns the new generation", () => {
    const store = createDocumentStore(reel(), durations);
    const asked = store.snapshot();
    const result = store.runCommand({ type: "applyProposal", baseGeneration: asked.generation, proposal: { ...asked.timeline, clips: [...asked.timeline.clips].reverse() } });
    expect(result.stale).toBeUndefined();
    expect(result.generation).toBe(asked.generation + 1);
    expect(store.getState().history.past).toHaveLength(1);
  });
});

describe("the Energy control (ADR 0059)", () => {
  const paced = () =>
    parseTimeline({
      version: 1,
      clips: ["a", "b", "c", "d"].map((id) => ({ id, assetId: `v-${id}`, kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 4000 })),
      texts: [{ id: "t", text: "Hall", startMs: 3500, endMs: 4500 }],
      music: { assetId: "song", sourceStartMs: 0, bpm: 120, beatOffsetMs: 0, sections: [{ kind: "intro", startMs: 0, endMs: 4000 }, { kind: "drop", startMs: 4000, endMs: 20000 }] },
    });
  const lengths = () => ({ "v-a": 20000, "v-b": 20000, "v-c": 20000, "v-d": 20000 });

  it("a drag across the stops is one undo step back to the reel as it was", () => {
    const store = createDocumentStore(paced(), lengths);
    const before = store.getState().history.present;
    for (const energy of [0.25, 0.5, 1, 0.75]) store.runCommand({ type: "pace", energy, clipEnergy: { a: 0.2, b: 0.9, c: 0.3, d: 0.4 }, speechAssetIds: [] }, "pace");
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().history.present.music?.energy).toBe(0.75);
    // The last stop is planned from the reel before the drag, not from the step before it.
    const direct = createDocumentStore(paced(), lengths);
    direct.runCommand({ type: "pace", energy: 0.75, clipEnergy: { a: 0.2, b: 0.9, c: 0.3, d: 0.4 }, speechAssetIds: [] }, "pace");
    expect(store.getState().history.present).toEqual(direct.getState().history.present);
    // The cut really changed (no clip has speech): b, which moves most, is the hero on the drop at 4 s.
    const cut = store.getState().history.present;
    expect(cut.clips).not.toEqual(before.clips);
    expect(cut.music?.pace?.heroClipId).toBe("b");
    store.dispatch({ type: "undo" });
    expect(store.getState().history.present).toBe(before);
  });
});
